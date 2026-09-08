import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const express = require('express');
const Db = require('./lib/db');
const { corsOriginPolicy } = require('./lib/security');
const ID = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const EXTENSION_ID = 'mhjagbgfpcefdmidgmbmfkfoabephnbm';

test('loaded companion: real worker, folder API, save, duplicate and navigation safety, light/dark accessibility', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'wadstube-companion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = join(root, 'extension');
  await cp(resolve(import.meta.dirname, '../../extension'), extension, { recursive: true });
  // Automation opens popup.html in an inactive tab, not a browser toolbar click.
  // Grant only the synthetic YouTube origin to this disposable test copy so real
  // executeScript can run. Production keeps activeTab and no YouTube host grant.
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('https://www.youtube.com/*');
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const db = new Db(join(root, 'wadstube.db'));
  const folder = (id, name, children = [], channels = []) => ({ id, name, children, channels });
  const state = { db, dataDir: root, apiKey: null, data: { version: 1, folders: [
    folder('science', 'Science & discovery', [folder('space', 'Space'), folder('nature', 'Natural world')]),
    folder('design', 'Design'), folder('music', 'Music'), folder('cooking', 'Cooking'),
    folder('technology', 'Technology'), folder('already', 'Already in your library', [], [{ id: ID, name: 'Veritasium' }]),
  ] } };
  const app = express(); app.use(express.json());
  app.use(corsOriginPolicy([`chrome-extension://${EXTENSION_ID}`]));
  app.use('/api/folders', require('./routes/folders')(state));
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await chromium.launchPersistentContext('', { headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP wadstube.runty.org 127.0.0.1, MAP www.youtube.com 127.0.0.1'] });
  t.after(() => context.close());
  const errors = [], mutations = [];
  let unavailable = false, holdSave = null;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.hostname === 'www.youtube.com') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><ytd-watch-flexy video-id="abcdefghijk"><div id="movie_player"></div></ytd-watch-flexy><script>
      window.fixture = {video_id:'abcdefghijk',author:'Veritasium',title:'The beautiful science hiding in everyday things'};
      window.ytInitialPlayerResponse = {videoDetails:{videoId:'abcdefghijk',channelId:'${ID}'}};
      document.querySelector('#movie_player').getVideoData = () => window.fixture;
      </script></body></html>` });
    if (url.hostname !== 'wadstube.runty.org' || !url.pathname.startsWith('/api/folders')) return route.abort();
    if (unavailable) return route.fulfill({ status: 503, json: { error: 'Synthetic outage' } });
    if (request.method() === 'POST') {
      mutations.push(request.postDataJSON());
      if (holdSave) await holdSave;
    }
    const response = await fetch(base + url.pathname + url.search, { method: request.method(),
      headers: { 'Content-Type': 'application/json', Origin: request.headers().origin || `chrome-extension://${EXTENSION_ID}` },
      ...(request.postData() ? { body: request.postData() } : {}) });
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).hostname, EXTENSION_ID);
  const youtube = await context.newPage();
  await youtube.goto('https://www.youtube.com/watch?v=abcdefghijk');
  const open = async () => {
    const pending = context.waitForEvent('page');
    await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false }));
    const page = await pending;
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    return page;
  };
  let popup = await open();
  await popup.getByRole('heading', { name: 'Veritasium', exact: true }).waitFor();
  await popup.getByRole('radio', { name: 'Science & discovery / Space', exact: true }).waitFor({ state: 'attached' });
  assert.equal(mutations.length, 0, 'opening must not save or refresh');
  assert(await popup.getByRole('radio', { name: /Already in your library/ }).isDisabled());
  assert.match(await popup.locator('#channel-handle').innerText(), /In 1 group already/);
  for (const theme of ['light', 'dark']) {
    await popup.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const violations = (await new AxeBuilder({ page: popup }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations;
    assert.deepEqual(violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], theme);
    const size = await popup.locator('body').boundingBox();
    t.diagnostic(`${theme}: popup ${size.width}×${size.height}`);
    assert(size.height <= 600, 'popup must fit Chrome’s height limit');
    await popup.screenshot({ path: `/tmp/wadstube-extension-${theme}.png`, clip: size });
  }
  await popup.getByRole('searchbox', { name: 'Find a group' }).fill('space');
  assert.equal(await popup.getByRole('radio').count(), 1);
  await popup.getByRole('radio').check();
  await popup.getByRole('button', { name: 'Add to Space', exact: true }).click();
  await popup.getByRole('heading', { name: 'Right where it belongs.' }).waitFor();
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0], { channelId: ID, channelName: 'Veritasium' });
  assert.equal(state.data.folders[0].children[0].channels[0].id, ID);
  assert.match(await popup.locator('#open-group').getAttribute('href'), /folder=space$/);
  await popup.getByRole('button', { name: 'Add to another group' }).click();
  await popup.waitForFunction(() => document.querySelector('input[value="space"]')?.disabled);
  // A changed video cannot accidentally save the channel that was previously shown.
  await popup.getByRole('radio', { name: 'Design', exact: true }).check();
  await youtube.evaluate(() => history.pushState({}, '', '/watch?v=bbbbbbbbbbb'));
  await popup.getByRole('button', { name: 'Add to Design', exact: true }).click();
  await popup.getByText('The YouTube video changed.', { exact: false }).waitFor();
  assert.equal(mutations.length, 1);
  await popup.close();
  await youtube.evaluate(() => history.pushState({}, '', '/watch?v=abcdefghijk'));
  popup = await open();
  await popup.waitForFunction(() => document.querySelector('input[value="space"]')?.disabled);
  assert.match(await popup.locator('#channel-handle').innerText(), /In 2 groups already/);
  await popup.close();
  // Worker owns the save; closing the popup must not cancel the user's action.
  let release;
  holdSave = new Promise(resolve => { release = resolve; });
  popup = await open();
  await popup.getByRole('radio', { name: 'Design', exact: true }).check();
  await popup.getByRole('button', { name: 'Add to Design', exact: true }).click();
  await popup.waitForFunction(() => document.querySelector('#save').disabled);
  while (mutations.length < 2) await new Promise(resolve => setTimeout(resolve, 20));
  await popup.close(); release(); holdSave = null;
  await new Promise(resolve => setTimeout(resolve, 200));
  popup = await open();
  await popup.waitForFunction(() => document.querySelector('input[value="design"]')?.disabled);
  unavailable = true;
  await popup.getByRole('button', { name: 'Reload groups', exact: true }).click();
  await popup.getByRole('alert').waitFor();
  assert(await popup.locator('#picker').isHidden());
  unavailable = false;
  await popup.getByRole('button', { name: 'Try again', exact: true }).click();
  await popup.locator('#picker').waitFor();
  assert.deepEqual(errors, []);
});
