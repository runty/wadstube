import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { videoIdFromUrl, flattenFolders, savePayload } from '../../extension/library.mjs';
import { readYouTubeChannel } from '../../extension/detect.mjs';

test('extension requests only click-time tab access and its one app host', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://wadstube.runty.org/*']);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(id, 'mhjagbgfpcefdmidgmbmfkfoabephnbm');
});

test('only canonical YouTube video contexts are accepted', () => {
  for (const url of ['https://www.youtube.com/watch?v=abcdefghijk', 'https://m.youtube.com/watch?v=abcdefghijk&list=example', 'https://youtube.com/shorts/abcdefghijk']) assert.equal(videoIdFromUrl(url), 'abcdefghijk');
  for (const url of ['https://www.youtube.com', 'https://youtube.com.evil/watch?v=abcdefghijk', 'http://youtube.com/watch?v=abcdefghijk', 'https://youtube.com/watch?v=x', 'https://youtube.com/@channel', 'javascript:alert(1)']) assert.equal(videoIdFromUrl(url), null);
});

test('folder search paths retain nested membership and duplicate names', () => {
  assert.deepEqual(flattenFolders([{ id: 'a', name: 'Science', containsChannel: false, children: [{ id: 'b', name: 'Space', containsChannel: true, children: [] }] }]).map(f => [f.id, f.path, f.added]), [['a', 'Science', false], ['b', 'Science / Space', true]]);
  assert.deepEqual(flattenFolders(null), []);
});

test('save payload cannot introduce arbitrary URLs, and canonical IDs avoid API lookup', () => {
  const channel = { videoId: 'abcdefghijk', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'Example', url: 'https://evil.example' };
  assert.deepEqual(savePayload(channel), { channelId: channel.channelId, channelName: 'Example' });
  assert.deepEqual(savePayload({ ...channel, channelId: null }), { url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  assert.throws(() => savePayload({ ...channel, videoId: 'bad' }));
});

test('YouTube detection rejects previous-video player and owner data during SPA navigation', t => {
  const originals = new Map(['document', 'window', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  } });
  let details = { video_id: 'abcdefghijk', channel_id: 'UCaaaaaaaaaaaaaaaaaaaaaa', author: 'Correct', title: 'Current' };
  const player = { getVideoData: () => details };
  const owner = { textContent: 'Old owner', querySelector: () => ({ getAttribute: () => '/channel/UCbbbbbbbbbbbbbbbbbbbbbb' }) };
  const root = { getAttribute: () => 'oldoldoldol', querySelector: query => query === '#movie_player' ? player : query.includes('channel-name') ? owner : null };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: query => query === '#movie_player' ? player : root } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { ytInitialPlayerResponse: { videoDetails: { videoId: 'oldoldoldol', channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb', author: 'Old' } } } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://www.youtube.com/watch?v=abcdefghijk' } });
  assert.equal(readYouTubeChannel().name, 'Correct');
  details = { ...details, video_id: 'oldoldoldol' };
  assert.equal(readYouTubeChannel().channelId, null);
  assert.equal(readYouTubeChannel().name, 'YouTube channel');
  globalThis.location.href = 'https://www.youtube.com/shorts/abcdefghijk';
  assert.equal(readYouTubeChannel().channelId, null, 'stale active Shorts owner must not be accepted');
  globalThis.location.href = 'https://www.youtube.com/watch?v=abcdefghijk';
  globalThis.window.ytInitialPlayerResponse.videoDetails = { videoId: 'abcdefghijk', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', author: 'Initial response' };
  assert.equal(readYouTubeChannel().name, 'Initial response');
  details = { video_id: 'abcdefghijk', author: 'Current player', title: 'Current' };
  assert.equal(readYouTubeChannel().channelId, 'UCaaaaaaaaaaaaaaaaaaaaaa', 'partial player data must not hide the matching initial channel ID');
  assert.equal(readYouTubeChannel().name, 'Current player');
  globalThis.window.ytInitialPlayerResponse.videoDetails.videoId = 'oldoldoldol';
  assert.equal(readYouTubeChannel().channelId, null, 'partial current data must not borrow a stale initial channel');
  player.getPlayerResponse = () => ({ videoDetails: { videoId: 'abcdefghijk', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(readYouTubeChannel().channelId, 'UCaaaaaaaaaaaaaaaaaaaaaa', 'current player response supports SPA navigation');
  player.getPlayerResponse = () => ({ videoDetails: { videoId: 'oldoldoldol', channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb' } });
  assert.equal(readYouTubeChannel().channelId, null, 'stale player responses must be rejected');
});
