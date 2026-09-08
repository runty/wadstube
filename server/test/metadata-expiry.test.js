const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Db = require("../lib/db");
const { refreshChannels } = require("../lib/refresh");
const { migrateCacheJsonIfNeeded } = require("../lib/migrate-cache");
const CHANNEL = "UCaaaaaaaaaaaaaaaaaaaaaa";
const NOW = "2026-09-07T12:00:00.000Z";
const CUTOFF = "2026-08-08T12:00:00.000Z";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-expiry-"));
  const db = new Db(path.join(dir, "wadstube.db"));
  db.upsertChannel(CHANNEL, "Fixture");
  t.after(() => { if (db.db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, dir };
}
const row = (id, extra = {}) => ({ video_id: id, channel_id: CHANNEL, title: `Unique ${id}`, published: "2020-01-01", short_status: "long", ...extra });

test("expiry uses actual metadata observation, not publication date, with an exact 30-day boundary", t => {
  const { db } = fixture(t);
  db.upsertVideos([row("expired")], { source: "api", observedAt: CUTOFF });
  db.upsertVideos([row("fresh")], { source: "rss", observedAt: "2026-08-08T12:00:00.001Z" });
  db.upsertVideos([row("offset")], { source: "api", observedAt: "2026-08-08T05:00:00-07:00" });
  db.upsertVideos([row("legacy", { created_at: CUTOFF })]);
  db.upsertVideos([row("invalid", { created_at: "invalid" })]);
  assert.equal(db.expireVideoMetadata(NOW), 4);
  assert.deepEqual(db.queryVideos().map(v => v.video_id), ["fresh"]);
  assert.deepEqual(db.queryVideos({ q: "expired" }), []);
  assert.equal(db.expireVideoMetadata(NOW), 0);
});

test("watch/star/hidden/acknowledgement state survives expiry, restart, and re-observation", t => {
  const { db } = fixture(t);
  db.upsertVideos([row("saved", { highlight_reason: "return_after_1_year" })], { source: "api", observedAt: CUTOFF });
  db.setVideoState("saved", { watched_at: true, starred_at: true, hidden_at: true });
  db.acknowledgeHighlights(["saved"]);
  const before = db.db.prepare("SELECT * FROM video_state WHERE video_id = 'saved'").get();
  assert.equal(db.expireVideoMetadata(NOW), 1);
  assert.equal(db.getUnreadCounts()[CHANNEL], undefined);
  assert.equal(db.listUnacknowledgedReturns().count, 0);
  assert.deepEqual(db.db.prepare("SELECT * FROM video_state WHERE video_id = 'saved'").get(), before);
  const file = db.dbFile;
  db.close();
  const reopened = new Db(file);
  try {
    assert.deepEqual(reopened.db.prepare("SELECT * FROM video_state WHERE video_id = 'saved'").get(), before);
    reopened.upsertVideos([row("saved", { title: "Fresh metadata" })], { source: "rss", observedAt: NOW });
    const restored = reopened.queryVideos({ view: "hidden" })[0];
    assert.equal(restored.title, "Fresh metadata");
    assert.equal(restored.watched, true);
    assert.equal(restored.starred, true);
    assert.equal(restored.hidden, true);
    reopened.pruneChannel(CHANNEL, 0);
    assert.deepEqual(reopened.db.prepare("SELECT * FROM video_state WHERE video_id = 'saved'").get(), before);
    reopened.purgeOrphanChannels(new Set());
    assert.equal(reopened.db.prepare("SELECT COUNT(*) n FROM video_state").get().n, 0);
  } finally { reopened.close(); }
});

test("migration 12 retains legacy dates and associates saved reader state without inventing verification", t => {
  const { db } = fixture(t);
  db.upsertVideos([row("legacy", { created_at: CUTOFF })]);
  db.setVideoState("legacy", { starred_at: true });
  const file = db.dbFile;
  db.db.exec(`DROP INDEX idx_videos_metadata_age; DROP INDEX idx_video_state_channel;
    ALTER TABLE videos DROP COLUMN metadata_source;
    ALTER TABLE videos DROP COLUMN metadata_observed_at;
    ALTER TABLE video_state DROP COLUMN channel_id;
    PRAGMA user_version = 11;`);
  db.close();
  const migrated = new Db(file);
  try {
    const video = migrated.db.prepare("SELECT * FROM videos").get();
    assert.equal(video.created_at, CUTOFF);
    assert.equal(video.metadata_source, "legacy");
    assert.equal(video.metadata_observed_at, null);
    assert.equal(migrated.expireVideoMetadata(NOW), 1);
    assert.equal(migrated.db.prepare("SELECT channel_id FROM video_state").get().channel_id, CHANNEL);
  } finally { migrated.close(); }
});

test("expiry is transactional and leaves validators/state unchanged on a failed delete", t => {
  const { db } = fixture(t);
  db.upsertVideos([row("old")], { source: "rss", observedAt: CUTOFF });
  db.updateChannelMeta(CHANNEL, { last_etag: "saved-etag", last_modified: "saved-date" });
  db.db.exec("CREATE TRIGGER stop_expiry BEFORE DELETE ON videos BEGIN SELECT RAISE(ABORT, 'expiry failed'); END;");
  assert.throws(() => db.expireVideoMetadata(NOW), /expiry failed/);
  assert.equal(db.hasVideo("old"), true);
  assert.equal(db.getChannelMeta(CHANNEL).last_etag, "saved-etag");
});

test("304 does not renew unseen metadata; expiry clears validators for the next manual RSS request", async t => {
  const { db } = fixture(t);
  db.upsertVideos([row("old")], { source: "rss", observedAt: CUTOFF });
  db.updateChannelMeta(CHANNEL, { last_etag: "saved-etag", last_modified: "saved-date" });
  let calls = 0;
  t.mock.method(global, "fetch", async (_url, options) => {
    calls++;
    assert.equal(options.headers["If-None-Match"], calls === 1 ? "saved-etag" : undefined);
    return new Response(null, { status: 304 });
  });
  await refreshChannels(db, [CHANNEL], { mode: "rss" });
  assert.equal(db.db.prepare("SELECT metadata_observed_at FROM videos").get().metadata_observed_at, CUTOFF);
  db.expireVideoMetadata(NOW);
  assert.equal(calls, 1, "expiry never makes a network request");
  await refreshChannels(db, [CHANNEL], { mode: "rss" });
  assert.equal(calls, 2);
});

test("API fallback records RSS provenance only for videos actually returned", async t => {
  const { db } = fixture(t);
  db.upsertVideos([row("unseen")], { source: "api", observedAt: CUTOFF });
  t.mock.method(global, "fetch", async url => {
    if (String(url).includes("playlistItems")) return Response.json({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 });
    if (String(url).includes("/shorts/")) return new Response(null, { status: 303, headers: { location: "/watch?v=" + String(url).split("/").at(-1) } });
    return new Response(`<feed><title>Fixture</title><entry><videoId>seen</videoId><channelId>${CHANNEL}</channelId><title>Seen</title><published>2020-01-01T00:00:00Z</published></entry></feed>`);
  });
  await refreshChannels(db, [CHANNEL], { mode: "api", apiKey: "fake" });
  const seen = db.db.prepare("SELECT metadata_source, metadata_observed_at FROM videos WHERE video_id = 'seen'").get();
  assert.equal(seen.metadata_source, "rss");
  assert.ok(seen.metadata_observed_at);
  assert.equal(db.db.prepare("SELECT metadata_observed_at FROM videos WHERE video_id = 'unseen'").get().metadata_observed_at, CUTOFF);
});

test("legacy cache imports without observation dates do not gain a fresh retention window", t => {
  const { db, dir } = fixture(t);
  db.purgeOrphanChannels(new Set());
  fs.writeFileSync(path.join(dir, "cache.json"), JSON.stringify({ channels: { [CHANNEL]: { videos: [row("imported")] } } }));
  migrateCacheJsonIfNeeded(db, dir);
  assert.equal(db.expireVideoMetadata(NOW), 1);
  assert.equal(db.hasVideo("imported"), false);
});

test("real service startup expires restored old metadata before serving while preserving reader state", async t => {
  const { spawn } = require("node:child_process");
  const { db, dir } = fixture(t);
  db.upsertVideos([row("startup", { created_at: "1970-01-01T00:00:00.000Z" })]);
  db.setVideoState("startup", { watched_at: true, starred_at: true });
  fs.writeFileSync(path.join(dir, "tube.json"), JSON.stringify({ version: 1, folders: [{ id: "fixture", name: "Fixture", channels: [{ id: CHANNEL, name: "Fixture" }], children: [] }] }));
  db.close();
  const child = spawn(process.execPath, [path.resolve(__dirname, "../index.js")], {
    env: { ...process.env, DATA_DIR: dir, PORT: "0", YOUTUBE_API_KEY: "", REFRESH_MODE: "rss", REFRESH_MODE_MANUAL: "rss" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture service startup timed out")), 10000);
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.stderr.on("data", chunk => { output += chunk; });
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("Server running on")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture service exited ${code}: ${output}`)); });
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.match(output, /expired 1 cached videos; reader state retained/);
  const reopened = new Db(path.join(dir, "wadstube.db"));
  try {
    assert.equal(reopened.hasVideo("startup"), false);
    assert.ok(reopened.db.prepare("SELECT starred_at FROM video_state WHERE video_id = 'startup'").get().starred_at);
  } finally { reopened.close(); }
});
