const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { corsOriginPolicy } = require('../lib/security');
const Db = require('../lib/db');
const ID = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const ORIGIN = 'chrome-extension://mhjagbgfpcefdmidgmbmfkfoabephnbm';

test('companion origin, direct group membership, bounded names and idempotent additions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wadstube-extension-api-'));
  const db = new Db(path.join(dir, 'wadstube.db'));
  const state = { dataDir: dir, db, apiKey: null, data: { version: 1, folders: [
    { id: 'root', name: 'Root', channels: [], children: [{ id: 'nested', name: 'Nested', channels: [], children: [] }] },
    { id: 'another', name: 'Another', channels: [], children: [] },
  ] } };
  const app = express();
  app.use(express.json()); app.use(corsOriginPolicy([ORIGIN]));
  app.use('/api/folders', require('../routes/folders')(state));
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/folders`;
  for (const origin of ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'null', 'https://evil.example', ORIGIN + '/path']) {
    const denied = await fetch(base + '/nested/channels', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: ID }) });
    assert.equal(denied.status, 403);
  }
  const preflight = await fetch(base, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  const add = (folder, name) => fetch(base + `/${folder}/channels`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: ID, channelName: name }) });
  assert.equal((await add('nested', '  Example\nchannel  ')).status, 200);
  assert.equal((await add('nested', 'Replacement')).status, 200);
  assert.equal(state.data.folders[0].children[0].channels.length, 1);
  assert.equal((await (await add('another', 'Replacement')).json()).channelName, 'Examplechannel');
  const folders = await (await fetch(base + '?channelId=' + ID)).json();
  assert.equal(folders[0].containsChannel, false, 'parent membership is not inferred from a child');
  assert.equal(folders[0].children[0].containsChannel, true);
  assert.equal(folders[1].containsChannel, true);
  assert.equal(Object.hasOwn((await (await fetch(base)).json())[0], 'containsChannel'), false);
  assert.equal((await fetch(base + '?channelId=bad')).status, 400);
  assert.equal((await fetch(base + '?channelId=x&channelId=y')).status, 400);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tube.json'), 'utf8')).folders[0].children[0].channels.length, 1);
});
