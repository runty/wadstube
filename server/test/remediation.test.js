const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Db = require("../lib/db");
const { refreshChannels, tryAcquireLock, releaseLock } = require("../lib/refresh");
const { evaluateRefresh, DEFAULT_POLICY } = require("../lib/refresh-policy");
const { createFullBackup, verifyFullBackup } = require("../lib/full-backup");
const { createBackup, listBackups, localDateString } = require("../lib/backup");
const { waitForTasksDrain } = require("../lib/shutdown");

const CHANNEL_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_B = "UCbbbbbbbbbbbbbbbbbbbbbb";

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-remediation-"));
  const db = new Db(path.join(dir, "wadstube.db"));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db };
}

function apiResponse(channelId, videoId) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ items: [{ snippet: {
      channelId, channelTitle: channelId, title: videoId,
      publishedAt: "2026-01-01T00:00:00.000Z",
      resourceId: { videoId }, thumbnails: {},
    } }] }),
  };
}

test("attempt and success timestamps split; failed no-history channels use bounded backoff", (t) => {
  const { db } = tempDb(t);
  db.upsertChannel(CHANNEL_A, "Failure");
  const at = "2026-07-19T12:00:00.000Z";
  db.recordChannelRefreshAttempt(CHANNEL_A, at);
  db.recordChannelRefreshFailure(CHANNEL_A, "boom", at);
  let meta = db.getChannelMeta(CHANNEL_A);
  assert.equal(meta.last_refresh_attempt_at, at);
  assert.equal(meta.last_refreshed_at, null);
  assert.equal(evaluateRefresh(meta, { now: "2026-07-19T12:04:59.000Z", policy: DEFAULT_POLICY }).due, false);
  assert.equal(evaluateRefresh(meta, { now: "2026-07-19T12:05:00.000Z", policy: DEFAULT_POLICY }).due, true);

  db.recordChannelRefreshAttempt(CHANNEL_A, "2026-07-19T12:05:00.000Z");
  db.recordChannelRefreshSuccess(CHANNEL_A, "2026-07-19T12:05:00.000Z", "ok", true);
  meta = db.getChannelMeta(CHANNEL_A);
  assert.equal(meta.last_refreshed_at, "2026-07-19T12:05:00.000Z");
  assert.equal(meta.consecutive_failures, 0);
  assert.equal(meta.last_refresh_had_upload, 1);
});

test("refresh waits for every worker and records unexpected worker failures", async (t) => {
  const { db } = tempDb(t);
  db.upsertChannel(CHANNEL_A, "A");
  db.upsertChannel(CHANNEL_B, "B");
  let siblingFinished = false;
  t.mock.method(global, "fetch", async (url) => {
    const value = String(url);
    if (value.includes("/shorts/")) return { status: 303 };
    const isB = value.includes(`playlistId=UU${CHANNEL_B.slice(2)}`);
    if (isB) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      siblingFinished = true;
      return apiResponse(CHANNEL_B, "video-b");
    }
    return apiResponse(CHANNEL_A, "video-a");
  });
  const original = db.upsertVideos.bind(db);
  db.upsertVideos = (rows) => {
    if (rows.some((row) => row.channel_id === CHANNEL_A)) throw new Error("injected worker failure");
    return original(rows);
  };
  const summary = await refreshChannels(db, [CHANNEL_A, CHANNEL_B], {
    mode: "api", apiKey: "key", policy: DEFAULT_POLICY,
  });
  assert.equal(siblingFinished, true, "refresh did not return before the delayed sibling settled");
  assert.equal(summary.checked, 2);
  assert.equal(summary.errors, 1);
  assert.equal(db.hasVideo("video-b"), true);
  assert.equal(db.getChannelMeta(CHANNEL_A).last_refreshed_at, null);
  assert.equal(db.getChannelMeta(CHANNEL_A).last_refresh_status, "error");
  assert.equal(db.listRefreshRuns(1)[0].status, "complete");
});

test("refresh callback and failure-recording errors cannot release workers early", async (t) => {
  const { db } = tempDb(t);
  db.upsertChannel(CHANNEL_A, "A");
  db.upsertChannel(CHANNEL_B, "B");
  let siblingFinished = false;
  t.mock.method(global, "fetch", async (url) => {
    const value = String(url);
    if (value.includes("/shorts/")) return { status: 303 };
    if (value.includes(`playlistId=UU${CHANNEL_B.slice(2)}`)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      siblingFinished = true;
      return apiResponse(CHANNEL_B, "video-b-safe");
    }
    return apiResponse(CHANNEL_A, "video-a-safe");
  });
  const originalUpsert = db.upsertVideos.bind(db);
  db.upsertVideos = (rows) => {
    if (rows.some((row) => row.channel_id === CHANNEL_A)) throw new Error("worker exploded");
    return originalUpsert(rows);
  };
  db.recordChannelRefreshFailure = () => { throw new Error("failure recorder exploded"); };
  const summary = await refreshChannels(
    db,
    [CHANNEL_A, CHANNEL_B],
    { mode: "api", apiKey: "key" },
    () => { throw new Error("progress consumer disconnected"); },
  );
  assert.equal(siblingFinished, true);
  assert.equal(summary.checked, 2);
  assert.equal(summary.errors, 1);
  assert.equal(db.hasVideo("video-b-safe"), true);
});

test("existing unknown in feed obeys pacing and pending return highlight survives", async (t) => {
  const { db } = tempDb(t);
  db.upsertChannel(CHANNEL_A, "Pending");
  db.upsertVideos([{
    video_id: "pending", channel_id: CHANNEL_A, title: "Pending",
    published: "2026-01-01", short_status: "unknown",
    pending_highlight_reason: "return_after_6_months",
  }]);
  db.recordVideoClassification("pending", "unknown", new Date().toISOString());
  let probes = 0;
  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("/shorts/")) { probes++; return { status: 303 }; }
    return apiResponse(CHANNEL_A, "pending");
  });
  const summary = await refreshChannels(db, [CHANNEL_A], { mode: "api", apiKey: "key" });
  assert.equal(probes, 0);
  assert.equal(summary.pending_unknown_total, 1);
  assert.equal(summary.pending_unknown_due, 0);
  db.recordVideoClassification("pending", "long", "2026-07-20T00:00:00.000Z");
  const row = db.queryVideos({ limit: 10 }).find((video) => video.video_id === "pending");
  assert.equal(row.highlight_reason, "return_after_6_months");
});

test("startup can abandon interrupted refresh runs", (t) => {
  const { db } = tempDb(t);
  const id = db.startRefreshRun({
    started_at: "2026-01-01T00:00:00.000Z", trigger: "manual",
    mode: "rss", scope: "x", requested_channels: 1,
  });
  assert.equal(db.markAbandonedRefreshRuns("2026-01-02T00:00:00.000Z"), 1);
  const run = db.listRefreshRuns(1)[0];
  assert.equal(run.id, id);
  assert.equal(run.status, "abandoned");
  assert.match(run.error, /stopped before refresh completed/);
});

test("full TAR export is exclusive, bounded-size, checksummed, and extractable", async (t) => {
  const { dir, db } = tempDb(t);
  db.db.exec("CREATE TABLE payload(bytes BLOB); INSERT INTO payload VALUES(randomblob(5000000));");
  const data = { version: 1, folders: [] };
  fs.writeFileSync(path.join(dir, "tube.json"), JSON.stringify(data));
  const appState = { data, db, refreshLock: null };
  const held = tryAcquireLock(appState);
  let completed = false;
  const creating = createFullBackup(dir, db, appState, { outputDir: dir }).then((value) => {
    completed = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(completed, false, "export must wait to own the refresh lock");
  releaseLock(appState, held);
  const backup = await creating;
  try {
    const snapshotSize = backup.manifest.files["wadstube.db"].bytes;
    const archiveSize = fs.statSync(backup.filePath).size;
    assert.ok(archiveSize < snapshotSize * 1.05 + 100_000, "archive must not have base64 expansion");
    const extractDir = path.join(dir, "extracted");
    assert.equal((await verifyFullBackup(backup.filePath, { extractDir })).ok, true);

    const unsupportedPath = path.join(dir, "unsupported-manifest.tar");
    fs.copyFileSync(backup.filePath, unsupportedPath);
    const archive = fs.readFileSync(unsupportedPath);
    const marker = archive.indexOf(Buffer.from("wadstube-full-backup"));
    assert.notEqual(marker, -1);
    fs.writeFileSync(
      unsupportedPath,
      Buffer.concat([
        archive.subarray(0, marker),
        Buffer.from("badstube-full-backup"),
        archive.subarray(marker + Buffer.byteLength("wadstube-full-backup")),
      ]),
    );
    const rejectedExtract = path.join(dir, "rejected-extract");
    await assert.rejects(
      () => verifyFullBackup(unsupportedPath, { extractDir: rejectedExtract }),
      /Unsupported or missing/,
    );
    assert.equal(fs.existsSync(rejectedExtract), false, "rejected manifests must remove extraction files");

    const archiveFd = fs.openSync(backup.filePath, "r+");
    try {
      const byte = Buffer.alloc(1);
      fs.readSync(archiveFd, byte, 0, 1, 2560);
      byte[0] ^= 0xff;
      fs.writeSync(archiveFd, byte, 0, 1, 2560);
    } finally { fs.closeSync(archiveFd); }
    await assert.rejects(() => verifyFullBackup(backup.filePath), /checksum verification failed/);
  } finally { backup.cleanup(); }
});

test("full backup releases its lock when temporary directory creation fails", async (t) => {
  const { dir, db } = tempDb(t);
  const appState = { data: { version: 1, folders: [] }, db, refreshLock: null };
  await assert.rejects(
    () => createFullBackup(dir, db, appState, { outputDir: path.join(dir, "missing") }),
    /ENOENT/,
  );
  assert.equal(appState.refreshLock, null);
  const next = tryAcquireLock(appState);
  assert.ok(next, "the failed export must not leak the global lock");
  releaseLock(appState, next);
});

test("failed same-day snapshot preserves the complete previous pair", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-backup-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "tube.json"), '{"new":true}');
  const destDir = path.join(dir, "backups", localDateString());
  fs.mkdirSync(destDir, { recursive: true });
  const dbDest = path.join(destDir, "wadstube.db");
  const tubeDest = path.join(destDir, "tube.json");
  fs.writeFileSync(dbDest, "known-good");
  fs.writeFileSync(tubeDest, '{"old":true}');
  const result = createBackup(dir, { vacuumInto() { throw new Error("injected snapshot failure"); } });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(dbDest, "utf8"), "known-good");
  assert.equal(fs.readFileSync(tubeDest, "utf8"), '{"old":true}');
  fs.mkdirSync(path.join(dir, "backups", "2026-01-01"));
  fs.writeFileSync(path.join(dir, "backups", "2026-01-01", "tube.json"), "incomplete");
  assert.deepEqual(listBackups(dir), [localDateString()]);
});

test("failed same-day directory publication rolls back the previous pair", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-backup-publish-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "tube.json"), '{"new":true}');
  const destDir = path.join(dir, "backups", localDateString());
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, "tube.json"), '{"old":true}');
  fs.writeFileSync(path.join(destDir, "wadstube.db"), "old-db");

  const originalRename = fs.renameSync.bind(fs);
  let renames = 0;
  t.mock.method(fs, "renameSync", (source, destination) => {
    renames++;
    if (renames === 2) throw new Error("injected publish failure");
    return originalRename(source, destination);
  });
  const result = createBackup(dir, {
    vacuumInto(destination) { fs.writeFileSync(destination, "new-db"); },
  });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(destDir, "tube.json"), "utf8"), '{"old":true}');
  assert.equal(fs.readFileSync(path.join(destDir, "wadstube.db"), "utf8"), "old-db");
});

test("refresh-run history can be bounded to newest rows", (t) => {
  const { db } = tempDb(t);
  for (let index = 0; index < 6; index++) {
    db.startRefreshRun({
      started_at: `2026-01-0${index + 1}T00:00:00.000Z`,
      trigger: "manual", mode: "rss", scope: String(index), requested_channels: 1,
    });
  }
  assert.equal(db.pruneRefreshRuns(3), 3);
  assert.deepEqual(db.listRefreshRuns(10).map((run) => run.scope), ["5", "4", "3"]);
});

test("shutdown task draining reports completion and timeout", async () => {
  assert.equal(await waitForTasksDrain([Promise.resolve()], 50), true);
  assert.equal(await waitForTasksDrain([new Promise(() => {})], 5), false);
});
