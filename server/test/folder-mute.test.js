const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Db = require('../lib/db');
const { normalizeTubeData, getFolderTreeSummary, saveData, loadData, refreshableChannelIds } = require('../lib/data');
const { buildRefreshPlan } = require('../lib/refresh-plan');
const { evaluateRefresh, DEFAULT_POLICY } = require('../lib/refresh-policy');
const { QuotaLedger } = require('../lib/quota');
const { refreshChannels, tryAcquireLock, releaseLock } = require('../lib/refresh');
const { restoreData } = require('../lib/restore');
const A = 'UCaaaaaaaaaaaaaaaaaaaaaa', B = 'UCbbbbbbbbbbbbbbbbbbbbbb', C = 'UCcccccccccccccccccccccc';
const folder = (id, ids, children = [], muted = false) => ({ id, name: id, channels: ids.map(id => ({ id, name: id, addedAt: '2026-01-01' })), children, ...(muted ? { muted: true } : {}) });
const tree = () => ({ version: 1, folders: [folder('sports', [A], [folder('wnba', [B]), folder('nested-muted', [C], [], true)], true), folder('other', [B])] });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wadstube-mute-'));
  const db = new Db(path.join(dir, 'wadstube.db'));
  const state = { data: tree(), dataDir: dir, db, quota: new QuotaLedger(db), manualMode: 'rss', maxVideos: 50, smartPolicy: DEFAULT_POLICY, refreshLock: null };
  saveData(dir, state.data);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return state;
}
async function listen(t, state) {
  const app = express(); app.use(express.json());
  app.use('/api/folders', require('../routes/folders')(state));
  app.use('/api/channels', require('../routes/channels')(state));
  app.use('/api/refresh', require('../routes/refresh')(state));
  app.use('/api/status', require('../routes/status')(state));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function recordRefresh(state) {
  const calls = [];
  state.refreshChannels = async (_db, ids, options) => {
    calls.push({ ids, options });
    return { checked: ids.length, updated: 0, new_videos: 0, new_shorts: 0, errors: 0, skipped: options.skipped || 0 };
  };
  return calls;
}

test('all channel histories refresh immediately; muting alone suppresses eligibility', () => {
  const now = new Date();
  for (const meta of [{}, { last_refreshed_at: now.toISOString() }, { last_refreshed_at: now.toISOString(), last_refresh_had_upload: 1 }, { last_refreshed_at: now.toISOString(), latest_upload_at: '2020-01-01' }, { last_refresh_status: 'error', last_refresh_attempt_at: now.toISOString(), consecutive_failures: 99 }]) {
    assert.equal(evaluateRefresh(meta, { now }).due, true);
    assert.equal(evaluateRefresh(meta, { now, muted: true, force: true }).due, false);
  }
});

test('mute persistence, inherited indicators, restore and scoped planning preserve unmuted memberships', async t => {
  const state = fixture(t);
  assert.deepEqual([...refreshableChannelIds(state.data)], [B]);
  assert.deepEqual([...refreshableChannelIds(state.data, 'wnba')], []);
  assert.deepEqual([...refreshableChannelIds(state.data, 'other')], [B]);
  const summary = getFolderTreeSummary(state.data);
  assert.equal(summary[0].muted, true);
  assert.equal(summary[0].children[0].muted, false);
  assert.equal(summary[0].children[0].refreshMuted, true);
  assert.equal(summary[1].refreshMuted, false);
  assert.deepEqual(loadData(state.dataDir), state.data);
  assert.equal(normalizeTubeData(state.data).folders[0].muted, true);
  assert.equal(normalizeTubeData({ folders: [{ ...folder('bad', []), muted: 'true' }] }).folders[0].muted, undefined);
  const plan = buildRefreshPlan(state);
  assert.deepEqual(plan.channels.dueIds, [B]);
  assert.equal(plan.channels.skippedByReason.muted_folder, 2);
  assert.equal(plan.fullPass.channelCount, 1);
  assert.equal(buildRefreshPlan(state, { folderId: 'sports' }).channels.due, 0);
  const restored = tree(); restored.folders[1].muted = true;
  await restoreData(state, restored);
  assert.equal(buildRefreshPlan(state).channels.due, 0);

});

test('mute endpoint waits for refresh, validates booleans, and leaves memory/disk unchanged on save failure', async t => {
  const state = fixture(t);
  const base = await listen(t, state);
  const mute = (id, muted) => fetch(`${base}/api/folders/${id}/mute`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ muted }) });
  assert.equal((await mute('other', 'true')).status, 400);
  assert.equal((await mute('missing', true)).status, 404);
  const handle = tryAcquireLock(state);
  let done = false;
  const request = mute('other', true).then(response => { done = true; return response; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(done, false);
  assert.equal(state.data.folders[1].muted, undefined);
  releaseLock(state, handle);
  assert.equal((await request).status, 200);
  assert.equal(loadData(state.dataDir).folders[1].muted, true);
  assert.equal((await mute('sports', false)).status, 200);
  assert.deepEqual([...refreshableChannelIds(state.data)], [A, B]);
  const before = state.data;
  const saved = fs.readFileSync(path.join(state.dataDir, 'tube.json'), 'utf8');
  fs.mkdirSync(path.join(state.dataDir, 'tube.json.tmp'));
  assert.equal((await mute('sports', true)).status, 500);
  assert.equal(state.data, before);
  assert.equal(fs.readFileSync(path.join(state.dataDir, 'tube.json'), 'utf8'), saved);
  assert.equal(state.refreshLock, null);
});

test('preview, execution, retry, bulk, health and quota agree about muting and shared membership', async t => {
  const state = fixture(t);
  const calls = recordRefresh(state);
  const base = await listen(t, state);
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const preview = await (await fetch(`${base}/api/refresh/preview`)).json();
  assert.deepEqual(preview.due_channel_ids, [B]);
  assert.equal(preview.skipped_count, 2);
  assert.equal(preview.next_due_at, null);
  await (await post('/api/refresh')).text();
  assert.deepEqual(calls.pop().ids, [B]);
  await (await post('/api/refresh/sports')).text();
  assert.deepEqual(calls.pop().ids, []);
  assert.equal((await post(`/api/channels/${A}/refresh`)).status, 409);
  assert.equal(calls.length, 0);
  assert.equal((await post(`/api/channels/${B}/refresh`)).status, 200);
  assert.deepEqual(calls.pop().ids, [B]);
  const bulk = await post('/api/channels/bulk/refresh', { channelIds: [A, B, C] });
  assert.equal(bulk.status, 200);
  assert.equal((await bulk.json()).summary.skipped, 2);
  assert.deepEqual(calls.pop().ids, [B]);
  const health = await (await fetch(`${base}/api/channels`)).json();
  assert.equal(health.find(row => row.id === A).smart_refresh.reason, 'muted_folder');
  assert.equal(health.find(row => row.id === B).smart_refresh.due, true);
  const forecast = await (await fetch(`${base}/api/status/quota/forecast`)).json();
  assert.equal(forecast.snapshot.dueChannels, 1);
  assert.equal(forecast.snapshot.fullPass.channelCount, 1);
});

test('pending Shorts retries cannot probe channels excluded by folder muting', async t => {
  const state = fixture(t);
  for (const id of [A, B]) {
    state.db.upsertChannel(id, id);
    state.db.upsertVideos([{ video_id: id === A ? 'muted-video' : 'ready-video', channel_id: id, title: 'Pending', published: '2026-10-01', short_status: 'unknown' }]);
  }
  assert.deepEqual(state.db.listPendingShorts(1, new Date().toISOString(), [B]).map(row => row.video_id), ['ready-video']);
  assert.deepEqual(state.db.listPendingShorts(10, new Date().toISOString(), []), []);
  const urls = [];
  t.mock.method(global, 'fetch', async url => {
    urls.push(String(url));
    if (String(url).includes('/feeds/')) return new Response(null, { status: 304 });
    return new Response(null, { status: 302, headers: { location: 'https://www.youtube.com/watch?v=ready-video' } });
  });
  await refreshChannels(state.db, [...refreshableChannelIds(state.data)], { policy: DEFAULT_POLICY });
  assert(urls.some(url => url.includes('/shorts/ready-video')));
  assert(urls.every(url => !url.includes('muted-video') && !url.includes(A)));
  assert.equal(state.db.getVideoClassification('muted-video'), 'unknown');
});
