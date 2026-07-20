const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const Db = require("../lib/db");
const { QuotaLedger } = require("../lib/quota");
const { DEFAULT_POLICY } = require("../lib/refresh-policy");
const {
  createBackup, listBackupDetails, localDateString, scheduleBackups,
  verifyBackup,
} = require("../lib/backup");
const statusRoutes = require("../routes/status");

const CHANNEL = "UCdddddddddddddddddddddd";

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-phase4-"));
  const db = new Db(path.join(dir, "wadstube.db"));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db };
}

async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const active = app.listen(0, "127.0.0.1", () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function appStateFor(dir, db, extras = {}) {
  const now = new Date("2026-07-19T12:00:00.000Z");
  return {
    dataDir: dir,
    data: { version: 1, folders: [{
      id: "root", name: "Root",
      channels: [{ id: CHANNEL, name: "D" }, {
        id: "https://youtube.com/legacy", name: "Legacy", unresolved: true,
      }],
      children: [],
    }] },
    db,
    quota: new QuotaLedger(db, {
      limits: { general: 100, search: 20 }, now: () => now,
    }),
    smartPolicy: DEFAULT_POLICY,
    smartPolicySource: "persisted",
    defaultMode: "rss",
    manualMode: "api",
    refreshIntervalMinutes: 0,
    refreshLock: null,
    activeTasks: new Set(),
    ...extras,
  };
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("quota history uses bounded Pacific days and forecast is snapshot-only", async (t) => {
  const { dir, db } = tempDb(t);
  db.reserveApiUsage({
    day: "2026-07-17", bucket: "general", endpoint: "playlistItems.list",
    units: 7, limit: 100,
  });
  db.reserveApiUsage({
    day: "2026-07-18", bucket: "general", endpoint: "playlistItems.list",
    units: 14, limit: 100,
  });
  db.reserveApiUsage({
    day: "2026-07-18", bucket: "search", endpoint: "search.list",
    units: 2, limit: 20,
  });
  const state = appStateFor(dir, db);
  const app = express();
  app.use("/api/status", statusRoutes(state));
  const base = await listen(t, app);

  let response = await fetch(`${base}/api/status/quota/history?days=3`);
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.equal(history.timezone, "America/Los_Angeles");
  assert.deepEqual(history.history.map((day) => day.quotaDay), [
    "2026-07-17", "2026-07-18", "2026-07-19",
  ]);
  assert.equal(history.history[1].buckets.general.units, 14);
  assert.equal(history.history[2].buckets.general.units, 0);
  assert.equal(history.current.quotaDay, "2026-07-19");

  response = await fetch(`${base}/api/status/quota/forecast`);
  assert.equal(response.status, 200);
  const forecast = await response.json();
  assert.equal(forecast.completeDayAverage.days, 7);
  assert.equal(forecast.completeDayAverage.endDay, "2026-07-18");
  assert.equal(forecast.completeDayAverage.buckets.general.totalUnits, 21);
  assert.equal(forecast.completeDayAverage.buckets.general.averageUnits, 3);
  assert.equal(forecast.snapshot.dueChannels, 1);
  assert.equal(forecast.snapshot.apiUnitsRequiredForApiMode, 1);
  assert.equal(forecast.snapshot.expectedApiUnitsIfRunNow, 1);
  assert.equal(forecast.snapshot.fullPass.channelCount, 1);
  assert.equal(forecast.timeProjection, null);

  state.quota.limits.general = 0;
  response = await fetch(`${base}/api/status/quota/forecast`);
  const fallbackForecast = await response.json();
  assert.equal(fallbackForecast.snapshot.effectiveMode, "rss");
  assert.equal(fallbackForecast.snapshot.apiUnitsRequiredForApiMode, 1);
  assert.equal(fallbackForecast.snapshot.expectedApiUnitsIfRunNow, 0);

  state.manualMode = "rss";
  response = await fetch(`${base}/api/status/quota/forecast`);
  const rssForecast = await response.json();
  assert.equal(rssForecast.snapshot.requestedMode, "rss");
  assert.equal(rssForecast.snapshot.effectiveMode, "rss");
  assert.equal(rssForecast.snapshot.fallbackReason, null);
  assert.equal(rssForecast.snapshot.apiUnitsRequiredForApiMode, 1);
  assert.equal(rssForecast.snapshot.expectedApiUnitsIfRunNow, 0);

  for (const query of ["0", "91", "7.5", "1e1", "-1"]) {
    response = await fetch(`${base}/api/status/quota/history?days=${encodeURIComponent(query)}`);
    assert.equal(response.status, 400, query);
  }
});

test("system GET is cheap and explicit database check is rate limited", async (t) => {
  const { dir, db } = tempDb(t);
  db.upsertChannel(CHANNEL, "D");
  db.upsertVideos([
    { video_id: "long-return", channel_id: CHANNEL, title: "Return", published: "2026-07-19T04:00:00Z", short_status: "long", highlight_reason: "return_after_3_months" },
    { video_id: "long", channel_id: CHANNEL, title: "Long", published: "2026-07-19T03:00:00Z", short_status: "long" },
    { video_id: "unknown-return", channel_id: CHANNEL, title: "Unknown", published: "2026-07-19T02:00:00Z", short_status: "unknown", highlight_reason: "return_after_1_year" },
    { video_id: "short", channel_id: CHANNEL, title: "Short", published: "2026-07-19T01:00:00Z", short_status: "short" },
  ]);
  db.setVideoState("long", { watched_at: true });
  let quickChecks = 0;
  const originalQuickCheck = db.quickCheck.bind(db);
  db.quickCheck = () => { quickChecks++; return originalQuickCheck(); };
  const state = appStateFor(dir, db, {
    version: "test-build",
    startedAt: "2026-07-19T00:00:00.000Z",
    refreshLock: Promise.resolve(),
    activeTasks: new Set([Promise.resolve()]),
    backupController: { status: () => ({
      scheduled: true, running: false, nextRunAt: "2026-07-20T08:00:00.000Z",
      lastSuccessAt: "2026-07-19T08:00:00.000Z", lastFailureAt: null,
      lastError: null,
    }) },
  });
  const app = express();
  app.use("/api/status", statusRoutes(state));
  const base = await listen(t, app);

  let response = await fetch(`${base}/api/status/system`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(quickChecks, 0, "GET health must not run SQLite quick_check");
  assert.equal(health.version, "test-build");
  assert.equal(health.refresh.locked, true);
  assert.equal(health.refresh.activeTasks, 1);
  assert.equal(health.refresh.defaultMode, "rss");
  assert.equal(health.refresh.manualMode, "api");
  assert.equal(health.refresh.policySource, "persisted");
  assert.equal(health.database.channelCount, 1);
  assert.equal(health.database.totalVideoCount, 4);
  assert.equal(health.database.visibleVideoCount, 3);
  assert.equal(health.database.shortCount, 1);
  assert.equal(health.database.returnVideoCount, 2);
  assert.equal(health.database.unknownVideoCount, 1);
  assert.equal(health.database.videoStateCount, 1);
  assert.equal((db.stmts.stats.source.match(/\bFROM videos\b/g) || []).length, 1,
    "system video counts must share one aggregate scan");
  assert.ok(health.database.databaseBytes > 0);
  assert.equal(health.database.journalMode, "wal");
  assert.equal(health.subscriptions.unresolvedMemberships, 1);
  assert.equal(health.backup.scheduled, true);

  for (let attempt = 1; attempt <= 4; attempt++) {
    response = await fetch(`${base}/api/status/system/database-check`, { method: "POST" });
    assert.equal(response.status, attempt <= 3 ? 200 : 429);
  }
  assert.equal(quickChecks, 3);
});

test("nightly backup verifies staged structure and preserves old snapshots on failure", (t) => {
  const { dir, db } = tempDb(t);
  const tubePath = path.join(dir, "tube.json");
  fs.writeFileSync(tubePath, JSON.stringify({ version: 1, folders: [] }));
  const first = createBackup(dir, db);
  assert.equal(first.ok, true);
  assert.equal(first.verification.quickCheck, "ok");
  const date = localDateString();
  const publishedTube = path.join(dir, "backups", date, "tube.json");
  const publishedDb = path.join(dir, "backups", date, "wadstube.db");
  const oldHashes = [hash(publishedTube), hash(publishedDb)];
  assert.equal(verifyBackup(dir, date).quickCheck, "ok");
  assert.equal(listBackupDetails(dir, 1)[0].date, date);

  fs.writeFileSync(tubePath, "{not-json");
  const badJson = createBackup(dir, db);
  assert.equal(badJson.ok, false);
  assert.match(badJson.error.message, /tube\.json parse failed/);
  assert.deepEqual([hash(publishedTube), hash(publishedDb)], oldHashes);

  fs.writeFileSync(tubePath, JSON.stringify({ version: 1, folders: [] }));
  const badSqlite = createBackup(dir, {
    vacuumInto(destination) { fs.writeFileSync(destination, "not sqlite"); },
  });
  assert.equal(badSqlite.ok, false);
  assert.match(badSqlite.error.message, /wadstube\.db verification failed/);
  assert.deepEqual([hash(publishedTube), hash(publishedDb)], oldHashes);
  assert.throws(() => verifyBackup(dir, "2026-02-30"), /valid YYYY-MM-DD/);
  assert.throws(() => listBackupDetails(dir, 101), /1 to 100/);
});

test("backup list and explicit verification endpoints reject unsafe or corrupt targets", async (t) => {
  const { dir, db } = tempDb(t);
  fs.writeFileSync(path.join(dir, "tube.json"), JSON.stringify({ version: 1, folders: [] }));
  assert.equal(createBackup(dir, db).ok, true);
  const date = localDateString();
  const state = appStateFor(dir, db);
  const app = express();
  app.use("/api/status", statusRoutes(state));
  const base = await listen(t, app);

  let response = await fetch(`${base}/api/status/backups?limit=1`);
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.backups.length, 1);
  assert.equal(body.backups[0].date, date);
  assert.equal(Object.hasOwn(body.backups[0], "directory"), false);

  response = await fetch(`${base}/api/status/backups/${date}/verify`, { method: "POST" });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(Object.hasOwn(body, "directory"), false);

  response = await fetch(`${base}/api/status/backups/2026-02-30/verify`, { method: "POST" });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/status/backups/2026-01-01/verify`, { method: "POST" });
  assert.equal(response.status, 404);
  response = await fetch(`${base}/api/status/backups?limit=1000`);
  assert.equal(response.status, 400);

  fs.writeFileSync(path.join(dir, "backups", date, "tube.json"), "broken");
  response = await fetch(`${base}/api/status/backups/${date}/verify`, { method: "POST" });
  assert.equal(response.status, 422);
});

test("backup controller exposes scheduled, running, and completion state", async (t) => {
  const { dir, db } = tempDb(t);
  fs.writeFileSync(path.join(dir, "tube.json"), JSON.stringify({ version: 1, folders: [] }));
  const state = appStateFor(dir, db);
  const controller = scheduleBackups(dir, db, state);
  state.backupController = controller;
  assert.equal(controller.status().scheduled, true);
  assert.ok(controller.status().nextRunAt);
  await Promise.all([...state.activeTasks]);
  const complete = controller.status();
  assert.equal(complete.running, false);
  assert.ok(complete.lastStartedAt);
  assert.ok(complete.lastCompletedAt);
  assert.ok(complete.lastSuccessAt);
  assert.equal(complete.lastError, null);
  controller.stop();
  assert.equal(controller.status().scheduled, false);
  assert.equal(controller.status().nextRunAt, null);
});

test("backup controller records structural verification failures without publishing", async (t) => {
  const { dir, db } = tempDb(t);
  fs.writeFileSync(path.join(dir, "tube.json"), "not-json");
  const state = appStateFor(dir, db);
  const controller = scheduleBackups(dir, db, state);
  await Promise.all([...state.activeTasks]);
  const failed = controller.status();
  assert.equal(failed.running, false);
  assert.ok(failed.lastFailureAt);
  assert.match(failed.lastError, /tube\.json parse failed/);
  assert.deepEqual(listBackupDetails(dir, 100), []);
  controller.stop();
});
