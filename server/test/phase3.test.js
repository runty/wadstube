const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Db = require("../lib/db");
const {
  DEFAULT_POLICY,
  MAX_REFRESH_INTERVAL_HOURS,
  MAX_UPLOAD_AGE_DAYS,
  MAX_FAILURE_RETRY_MINUTES,
  evaluateRefresh,
  strongestMatchingRule,
  validatePolicy,
} = require("../lib/refresh-policy");
const { buildRefreshPlan } = require("../lib/refresh-plan");
const { QuotaLedger, quotaDay, resetAtForDay } = require("../lib/quota");
const { youtubeApiRequest } = require("../lib/youtube");
const { refreshChannels } = require("../lib/refresh");
const { createFullBackup, verifyFullBackup } = require("../lib/full-backup");
const { waitForRefreshDrain } = require("../lib/shutdown");

const CHANNEL = "UCcccccccccccccccccccccc";

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-phase3-"));
  const db = new Db(path.join(dir, "wadstube.db"));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db };
}

test("smart policy selects the strongest rule at exact boundaries and is extensible", () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  assert.equal(strongestMatchingRule(daysAgo(89), now, DEFAULT_POLICY), null);
  assert.equal(strongestMatchingRule(daysAgo(90), now, DEFAULT_POLICY).id, "return_after_3_months");
  assert.equal(strongestMatchingRule(daysAgo(364), now, DEFAULT_POLICY).id, "return_after_3_months");
  assert.equal(strongestMatchingRule(daysAgo(365), now, DEFAULT_POLICY).id, "return_after_1_year");

  const sixHours = evaluateRefresh({
    latest_upload_at: daysAgo(90),
    last_refreshed_at: new Date(now.getTime() - 6 * 3600000).toISOString(),
  }, { now, policy: DEFAULT_POLICY });
  assert.equal(sixHours.due, true);
  assert.equal(sixHours.intervalHours, 6);

  const noHistory = evaluateRefresh({
    latest_upload_at: null,
    last_refreshed_at: new Date(now.getTime() - 23 * 3600000).toISOString(),
  }, { now, policy: DEFAULT_POLICY });
  assert.equal(noHistory.due, false);
  assert.equal(evaluateRefresh({}, { now, policy: DEFAULT_POLICY }).due, true);
  assert.equal(evaluateRefresh({ last_refreshed_at: now.toISOString() }, { now, force: true }).due, true);
  const uploadCooldown = evaluateRefresh({
    last_refreshed_at: now.toISOString(),
    latest_upload_at: daysAgo(1),
    last_refresh_had_upload: 1,
  }, { now, policy: DEFAULT_POLICY, baseIntervalMinutes: 0 });
  assert.equal(uploadCooldown.due, false);
  assert.equal(uploadCooldown.reason, "new_upload_cooldown");
  assert.equal(uploadCooldown.intervalHours, 2);
  assert.equal(evaluateRefresh({
    last_refreshed_at: new Date(now.getTime() - 2 * 3600000).toISOString(),
    latest_upload_at: daysAgo(1),
    last_refresh_had_upload: 1,
  }, { now, policy: DEFAULT_POLICY, baseIntervalMinutes: 0 }).due, true);
  assert.equal(evaluateRefresh({
    last_refreshed_at: now.toISOString(),
    latest_upload_at: daysAgo(1),
  }, { now, policy: DEFAULT_POLICY, baseIntervalMinutes: 0 }).due, true);

  const extended = validatePolicy({
    noHistoryIntervalHours: 48,
    newUploadCooldownHours: 3,
    rules: [...DEFAULT_POLICY.rules, {
      id: "return_after_2_years", label: "Returned after 2 years",
      minUploadAgeDays: 730, minRefreshIntervalHours: 72,
    }],
  });
  assert.equal(strongestMatchingRule(daysAgo(800), now, extended).id, "return_after_2_years");
  assert.throws(() => validatePolicy({ rules: [{ id: "bad id", minUploadAgeDays: 1, minRefreshIntervalHours: 1 }] }), /invalid id/);

  const maximumPolicy = {
    noHistoryIntervalHours: MAX_REFRESH_INTERVAL_HOURS,
    newUploadCooldownHours: MAX_REFRESH_INTERVAL_HOURS,
    failureRetryMinutes: [MAX_FAILURE_RETRY_MINUTES],
    rules: [{
      id: "maximum_bounds", label: "Maximum bounds",
      minUploadAgeDays: MAX_UPLOAD_AGE_DAYS,
      minRefreshIntervalHours: MAX_REFRESH_INTERVAL_HOURS,
    }],
  };
  const plannerState = {
    data: { folders: [{ id: "root", channels: [{ id: CHANNEL }], children: [] }] },
    db: { listChannelRefreshMeta: () => [{ id: CHANNEL, last_refreshed_at: now.toISOString() }] },
    manualMode: "rss", quota: null, smartPolicy: maximumPolicy,
  };
  const maximumPlan = buildRefreshPlan(plannerState, { now });
  assert.equal(maximumPlan.channels.plans[0].interval_hours, MAX_REFRESH_INTERVAL_HOURS);
  assert.doesNotThrow(() => new Date(maximumPlan.channels.plans[0].next_due_at).toISOString());
  for (const excessive of [
    {
      hours: MAX_REFRESH_INTERVAL_HOURS + 0.5,
      days: MAX_UPLOAD_AGE_DAYS + 0.5,
      retry: MAX_FAILURE_RETRY_MINUTES + 0.5,
    },
    { hours: 1e308, days: 1e308, retry: 1e308 },
  ]) {
    const invalidPolicies = [
      { ...maximumPolicy, noHistoryIntervalHours: excessive.hours },
      { ...maximumPolicy, newUploadCooldownHours: excessive.hours },
      { ...maximumPolicy, failureRetryMinutes: [excessive.retry] },
      { ...maximumPolicy, rules: [{ ...maximumPolicy.rules[0], minUploadAgeDays: excessive.days }] },
      { ...maximumPolicy, rules: [{ ...maximumPolicy.rules[0], minRefreshIntervalHours: excessive.hours }] },
    ];
    for (const smartPolicy of invalidPolicies) {
      assert.throws(() => buildRefreshPlan({ ...plannerState, smartPolicy }, { now }), /at most/);
    }
  }
});

test("quota ledger uses Pacific days, separate buckets, failure accounting, and conservative budget", async (t) => {
  const { db } = tempDb(t);
  const now = new Date("2026-03-08T09:30:00.000Z");
  const quota = new QuotaLedger(db, { limits: { general: 1, search: 2 }, now: () => now });
  assert.equal(quotaDay(now), "2026-03-08");
  assert.equal(resetAtForDay("2026-03-08"), "2026-03-09T07:00:00.000Z");
  let fetches = 0;
  t.mock.method(global, "fetch", async () => {
    fetches++;
    return { ok: false, status: 403, statusText: "Forbidden", json: async () => ({ error: { errors: [{ reason: "forbidden" }] } }) };
  });
  await assert.rejects(() => youtubeApiRequest("key", "videos", { part: "snippet", id: "x" }, "test", { quota }), /forbidden/);
  assert.equal(fetches, 1);
  assert.equal(quota.status().buckets.general.used, 1, "failed response still consumes the reserved call");
  await assert.rejects(() => youtubeApiRequest("key", "videos", {}, "blocked", { quota }), /exhausted/);
  assert.equal(fetches, 1, "budget rejection occurs before a network request");
  quota.reserve("search.list");
  assert.equal(quota.status().buckets.search.used, 1);
});

test("return upload is highlighted only after a prior stale refresh and run usage persists", async (t) => {
  const { db } = tempDb(t);
  db.upsertChannel(CHANNEL, "Returning");
  const quota = new QuotaLedger(db, { limits: { general: 100, search: 10 } });
  const oldPublished = new Date(Date.now() - 200 * 86400000).toISOString();
  let pass = 1;
  t.mock.method(global, "fetch", async (url) => {
    const value = String(url);
    if (value.includes("/playlistItems?")) {
      const items = [{ snippet: { channelId: CHANNEL, channelTitle: "Returning", title: "Old", publishedAt: oldPublished, resourceId: { videoId: "old-video" }, thumbnails: {} } }];
      if (pass === 2) items.push({ snippet: { channelId: CHANNEL, channelTitle: "Returning", title: "Return", publishedAt: new Date().toISOString(), resourceId: { videoId: "return-video" }, thumbnails: {} } });
      return { ok: true, status: 200, json: async () => ({ items }) };
    }
    return { status: 303 };
  });

  let summary = await refreshChannels(db, [CHANNEL], {
    mode: "api", apiKey: "key", quota, policy: DEFAULT_POLICY, trigger: "manual", scope: "test",
  });
  assert.equal(db.queryVideos({ limit: 10 }).find((row) => row.video_id === "old-video").highlight_reason, null);
  assert.equal(summary.api_units, 1);
  assert.equal(summary.daily_remaining, 99);
  pass = 2;
  summary = await refreshChannels(db, [CHANNEL], {
    mode: "api", apiKey: "key", quota, policy: DEFAULT_POLICY, trigger: "manual", scope: "test",
  });
  assert.equal(db.queryVideos({ limit: 10 }).find((row) => row.video_id === "return-video").highlight_reason, "return_after_3_months");
  const run = db.listRefreshRuns(1)[0];
  assert.equal(run.id, summary.run_id);
  assert.equal(run.new_videos, 1);
  assert.equal(run.api_units, 1);
  assert.equal(run.api_by_endpoint["playlistItems.list"].calls, 1);
  assert.equal(run.shorts_probes, 1);
});

test("unknown Shorts are durably selected with paced retries outside a feed window", (t) => {
  const { db } = tempDb(t);
  db.upsertChannel(CHANNEL, "Pending");
  db.upsertVideos([{ video_id: "pending-short", channel_id: CHANNEL, title: "Pending", published: "2026-01-01", short_status: "unknown" }]);
  const first = "2026-07-19T12:00:00.000Z";
  assert.equal(db.listPendingShorts(10, first).length, 1);
  db.recordVideoClassification("pending-short", "unknown", first);
  assert.equal(db.listPendingShorts(10, "2026-07-19T12:09:59.000Z").length, 0);
  assert.equal(db.listPendingShorts(10, "2026-07-19T12:10:00.000Z").length, 1);
  db.recordVideoClassification("pending-short", "long", "2026-07-19T12:10:00.000Z");
  assert.equal(db.listPendingShorts(10, "2026-07-20T12:00:00.000Z").length, 0);
});

test("FTS search is correct and verified full export contains both checksummed files", async (t) => {
  const { dir, db } = tempDb(t);
  db.upsertChannel(CHANNEL, "Coffee Lab");
  db.upsertVideos([{ video_id: "fts-video", channel_id: CHANNEL, title: "Espresso extraction", description: "Dial in coffee", published: "2026-01-01", short_status: "long" }]);
  assert.equal(db.queryVideos({ q: "espresso", limit: 5 })[0].video_id, "fts-video");
  assert.doesNotThrow(() => db.queryVideos({ q: 'espresso " grinder', limit: 5 }));

  const data = { version: 1, folders: [] };
  fs.writeFileSync(path.join(dir, "tube.json"), JSON.stringify(data));
  const appState = { data, db, refreshLock: null };
  const backup = await createFullBackup(dir, db, appState, { outputDir: dir });
  try {
    const extractDir = path.join(dir, "verified-extract");
    const verified = await verifyFullBackup(backup.filePath, { extractDir });
    assert.equal(verified.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(extractDir, "tube.json"))).version, 1);
    assert.ok(fs.statSync(path.join(extractDir, "wadstube.db")).size > 0);
  } finally { backup.cleanup(); }
});

test("refresh drain helper resolves completion and bounded timeout", async () => {
  let release;
  const appState = { refreshLock: new Promise((resolve) => { release = resolve; }) };
  setTimeout(release, 5);
  assert.equal(await waitForRefreshDrain(appState, 100), true);
  assert.equal(await waitForRefreshDrain({ refreshLock: new Promise(() => {}) }, 5), false);
});
