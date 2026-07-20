const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const Db = require("../lib/db");
const { refreshChannels } = require("../lib/refresh");
const {
  DEFAULT_POLICY,
  MAX_REFRESH_INTERVAL_HOURS,
  MAX_UPLOAD_AGE_DAYS,
  MAX_FAILURE_RETRY_MINUTES,
  validatePolicy,
} = require("../lib/refresh-policy");
const { SMART_REFRESH_POLICY_KEY, loadSmartRefreshPolicy } = require("../lib/settings");
const { postOnly, rateLimit } = require("../lib/security");

const CHANNEL_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_B = "UCbbbbbbbbbbbbbbbbbbbbbb";

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-phase1-"));
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

function summaryFor(options) {
  return {
    checked: 0, updated: 0, new_videos: 0, new_shorts: 0,
    classification_unknown: 0, errors: 0, skipped: options.skipped || 0,
    run_id: 1, api_calls: 0, api_units: 0, api_by_endpoint: {},
    rss_requests: 0, requested_mode: options.requestedMode,
    effective_mode: options.mode, rss_fallbacks: 0,
    fallback_reason: options.fallbackReason || null, shorts_probes: 0,
    pending_unknown_total: 0, pending_unknown_due: 0,
    pending_reclassified: 0, daily_remaining: null, quota: null,
  };
}

test("refresh finalizes skipped count before persistence and return", async () => {
  let persisted = null;
  const db = {
    startRefreshRun() { return 7; },
    finishRefreshRun(_id, summary) { persisted = summary; },
  };
  const result = await refreshChannels(db, [], { skipped: 4 });
  assert.equal(result.skipped, 4);
  assert.equal(persisted.skipped, 4);
  assert.equal(result.run_id, 7);
});

test("app settings migrate additively and preserve JSON values", (t) => {
  const { db } = tempDb(t);
  assert.equal(db.db.pragma("user_version", { simple: true }), 11);
  assert.equal(db.getSetting(SMART_REFRESH_POLICY_KEY), null);
  const value = { noHistoryIntervalHours: 36, nested: { enabled: true } };
  db.setSetting(SMART_REFRESH_POLICY_KEY, value, "2026-07-19T00:00:00.000Z");
  assert.deepEqual(db.getSetting(SMART_REFRESH_POLICY_KEY), value);
  assert.equal(db.deleteSetting(SMART_REFRESH_POLICY_KEY), true);
  assert.equal(db.getSetting(SMART_REFRESH_POLICY_KEY), null);
});

test("refresh preview shares planning, reports scope and has no side effects", async (t) => {
  const { dir, db } = tempDb(t);
  const now = new Date();
  db.upsertChannel(CHANNEL_A, "A");
  db.setLatestUploadAt(CHANNEL_A, new Date(now.getTime() - 86400000).toISOString());
  db.recordChannelRefreshSuccess(CHANNEL_A, now.toISOString(), "ok", true);
  const unresolved = { id: "https://www.youtube.com/c/legacy", name: "Legacy", unresolved: true };
  const data = {
    version: 1,
    folders: [{
      id: "root", name: "Root",
      channels: [{ id: CHANNEL_A, name: "A" }, unresolved],
      children: [{ id: "child", name: "Child", channels: [{ id: CHANNEL_B, name: "B" }], children: [] }],
    }, {
      id: "other", name: "Other", channels: [{ id: CHANNEL_B, name: "B" }], children: [],
    }, {
      id: "empty", name: "Empty", channels: [], children: [],
    }],
  };
  const assertedUnits = [];
  let reservations = 0;
  let refreshCalls = 0;
  const quota = {
    assertCanSpend(_bucket, units) { assertedUnits.push(units); },
    reserve() { reservations++; },
    status() {
      return { buckets: { general: { used: 9, limit: 10, remaining: 1 } } };
    },
  };
  const appState = {
    data, dataDir: dir, db, quota, apiKey: "key", manualMode: "api",
    maxVideos: 50, smartPolicy: DEFAULT_POLICY, refreshLock: null,
    refreshChannels: async (_db, _ids, options) => {
      refreshCalls++;
      return summaryFor(options);
    },
  };
  const app = express();
  app.use("/api/refresh", require("../routes/refresh")(appState));
  const base = await listen(t, app);
  const runsBefore = db.listRefreshRuns(100).length;
  const channelsBefore = db.getStats().channelCount;

  let response = await fetch(`${base}/api/refresh/preview`);
  assert.equal(response.status, 200);
  const all = await response.json();
  assert.equal(all.membership_count, 4);
  assert.equal(all.unique_channel_count, 2);
  assert.equal(all.unresolved_count, 1);
  assert.equal(all.due_count, 1);
  assert.equal(all.skipped_count, 2);
  assert.equal(all.skipped_by_reason.unresolved, 1);
  assert.equal(all.skipped_by_reason.new_upload_cooldown, 1);
  assert.equal(all.requested_mode, "api");
  assert.equal(all.effective_mode, "api");
  assert.equal(all.projected_required_api_units, 1);
  assert.equal(all.quota.buckets.general.remaining, 1);
  assert.deepEqual(all.full_pass, {
    channel_count: 2, projected_api_units: 2, current_remaining: 1,
    can_cover: false, complete_passes_remaining: 0,
  });

  response = await fetch(`${base}/api/refresh/preview/Root`);
  assert.equal(response.headers.get("deprecation"), "true");
  const folder = await response.json();
  assert.equal(folder.scope, "root");
  assert.equal(folder.membership_count, 3);
  assert.equal(folder.unique_channel_count, 2);
  response = await fetch(`${base}/api/refresh/preview/empty`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).membership_count, 0);
  assert.equal((await fetch(`${base}/api/refresh/preview/missing`)).status, 404);
  assert.equal(refreshCalls, 0);
  assert.equal(reservations, 0);
  assert.equal(db.listRefreshRuns(100).length, runsBefore);
  assert.equal(db.getStats().channelCount, channelsBefore);
  assert.equal(db.getChannelMeta(CHANNEL_B), null, "preview must not seed channel titles");
  assert.equal(appState.refreshLock, null);
  assert.deepEqual(assertedUnits, [1, 1, 0]);

  // Make the previously-due channel ineligible after preview. POST must build
  // a new plan under the lock and pass that result to execution.
  db.upsertChannel(CHANNEL_B, "B");
  db.setLatestUploadAt(CHANNEL_B, new Date().toISOString());
  db.recordChannelRefreshSuccess(CHANNEL_B, new Date().toISOString(), "ok", true);
  let executedIds = null;
  let executedOptions = null;
  appState.refreshChannels = async (_db, ids, options) => {
    executedIds = ids;
    executedOptions = options;
    return summaryFor(options);
  };
  // Rebuild the router so its injected execution function observes the stub.
  const postApp = express();
  postApp.use("/api/refresh", require("../routes/refresh")(appState));
  const postBase = await listen(t, postApp);
  response = await fetch(`${postBase}/api/refresh`, { method: "POST" });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  const report = events.find((event) => event.type === "summary");
  assert.deepEqual(executedIds, []);
  assert.equal(executedOptions.skipped, 3);
  assert.equal(report.skipped, 3);
  response = await fetch(`${postBase}/api/refresh/empty`, { method: "POST" });
  assert.equal(response.status, 200);
  const emptyEvents = (await response.text()).trim().split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(emptyEvents.find((event) => event.type === "summary").skipped, 0);
  assert.equal((await fetch(`${postBase}/api/refresh/missing`, { method: "POST" })).status, 404);
  assert.deepEqual(assertedUnits, [1, 1, 0, 0, 0]);
});

test("production refresh limiter counts POST execution but not preview GETs", async (t) => {
  const { dir, db } = tempDb(t);
  const appState = {
    data: { version: 1, folders: [] }, dataDir: dir, db, quota: null,
    apiKey: null, manualMode: "rss", maxVideos: 50,
    smartPolicy: DEFAULT_POLICY, refreshLock: null,
    refreshChannels: async (_db, _ids, options) => summaryFor(options),
  };
  const app = express();
  app.use(
    "/api/refresh",
    postOnly(rateLimit({ windowMs: 60_000, max: 1, name: "refresh" })),
  );
  app.use("/api/refresh", require("../routes/refresh")(appState));
  const base = await listen(t, app);
  for (let index = 0; index < 12; index++) {
    assert.equal((await fetch(`${base}/api/refresh/preview`)).status, 200);
  }
  assert.equal((await fetch(`${base}/api/refresh`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${base}/api/refresh`, { method: "POST" })).status, 429);
});

test("smart refresh setting validates, persists, drives routes, and resets", async (t) => {
  const { dir, db } = tempDb(t);
  db.upsertChannel(CHANNEL_A, "A");
  db.recordChannelRefreshSuccess(CHANNEL_A, new Date().toISOString(), "ok", false);
  const data = {
    version: 1,
    folders: [{ id: "root", name: "Root", channels: [{ id: CHANNEL_A, name: "A" }], children: [] }],
  };
  const defaultPolicy = validatePolicy({
    noHistoryIntervalHours: 30,
    newUploadCooldownHours: 4,
    failureRetryMinutes: [11, 22],
    rules: [{
      id: "environment_default", label: "Environment default",
      minUploadAgeDays: 45, minRefreshIntervalHours: 9,
    }],
  });
  let refreshPolicy = null;
  const appState = {
    data, dataDir: dir, db, quota: null, apiKey: null, manualMode: "rss",
    maxVideos: 50, defaultSmartPolicy: defaultPolicy,
    smartPolicy: defaultPolicy, smartPolicySource: "environment",
    refreshIntervalMinutes: 0, refreshLock: null,
    refreshChannels: async (_db, _ids, options) => {
      refreshPolicy = options.policy;
      return summaryFor(options);
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/settings", require("../routes/settings")(appState));
  app.use("/api/channels", require("../routes/channels")(appState));
  app.use("/api/refresh", require("../routes/refresh")(appState));
  const base = await listen(t, app);

  let response = await fetch(`${base}/api/settings/smart-refresh`);
  assert.equal((await response.json()).source, "environment");
  response = await fetch(`${base}/api/settings/smart-refresh`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: { rules: [{ id: "bad id" }] } }),
  });
  assert.equal(response.status, 400);
  assert.equal(db.getSetting(SMART_REFRESH_POLICY_KEY), null);

  for (const body of [{}, { policy: null }, { policy: [] }, { policy: "bad" }]) {
    response = await fetch(`${base}/api/settings/smart-refresh`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }

  response = await fetch(`${base}/api/settings/smart-refresh`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: {} }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).policy, defaultPolicy);

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
  response = await fetch(`${base}/api/settings/smart-refresh`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: maximumPolicy }),
  });
  assert.equal(response.status, 200, "documented maximum values remain valid");
  for (const excessive of [
    {
      hours: MAX_REFRESH_INTERVAL_HOURS + 0.5,
      days: MAX_UPLOAD_AGE_DAYS + 0.5,
      retry: MAX_FAILURE_RETRY_MINUTES + 0.5,
    },
    { hours: 1e308, days: 1e308, retry: 1e308 },
  ]) {
    const invalidPolicies = [
      { noHistoryIntervalHours: excessive.hours },
      { newUploadCooldownHours: excessive.hours },
      { failureRetryMinutes: [excessive.retry] },
      { rules: [{ id: "age_too_large", minUploadAgeDays: excessive.days, minRefreshIntervalHours: 1 }] },
      { rules: [{ id: "interval_too_large", minUploadAgeDays: 1, minRefreshIntervalHours: excessive.hours }] },
    ];
    for (const policy of invalidPolicies) {
      response = await fetch(`${base}/api/settings/smart-refresh`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      assert.equal(response.status, 400);
    }
  }

  response = await fetch(`${base}/api/settings/smart-refresh`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: { noHistoryIntervalHours: 48 } }),
  });
  assert.equal(response.status, 200);
  const partial = (await response.json()).policy;
  assert.equal(partial.noHistoryIntervalHours, 48);
  assert.equal(partial.newUploadCooldownHours, 4);
  assert.deepEqual(partial.failureRetryMinutes, [11, 22]);
  assert.deepEqual(partial.rules, defaultPolicy.rules);

  const custom = {
    noHistoryIntervalHours: 48,
    newUploadCooldownHours: 3,
    failureRetryMinutes: [7, 30],
    rules: [{
      id: "return_after_2_days", label: "Returned after 2 days",
      minUploadAgeDays: 2, minRefreshIntervalHours: 12,
    }],
  };
  response = await fetch(`${base}/api/settings/smart-refresh`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: custom }),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.source, "persisted");
  assert.deepEqual(db.getSetting(SMART_REFRESH_POLICY_KEY), saved.policy);
  assert.equal(appState.smartPolicy.noHistoryIntervalHours, 48);
  const reloaded = loadSmartRefreshPolicy(db, defaultPolicy);
  assert.equal(reloaded.source, "persisted");
  assert.deepEqual(reloaded.policy, saved.policy);

  const health = await (await fetch(`${base}/api/channels`)).json();
  assert.equal(health[0].smart_refresh.intervalHours, 48);
  await (await fetch(`${base}/api/refresh`, { method: "POST" })).text();
  assert.equal(refreshPolicy, appState.smartPolicy);

  const persistedBeforeFailure = db.getSetting(SMART_REFRESH_POLICY_KEY);
  const policyBeforeFailure = appState.smartPolicy;
  const realSetSetting = db.setSetting.bind(db);
  const realDeleteSetting = db.deleteSetting.bind(db);
  let failSet = true;
  let failDelete = true;
  db.setSetting = (...args) => {
    if (failSet) throw new Error("injected setting write failure");
    return realSetSetting(...args);
  };
  db.deleteSetting = (...args) => {
    if (failDelete) throw new Error("injected setting delete failure");
    return realDeleteSetting(...args);
  };
  response = await fetch(`${base}/api/settings/smart-refresh`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: { noHistoryIntervalHours: 72 } }),
  });
  assert.equal(response.status, 500);
  assert.equal(appState.smartPolicy, policyBeforeFailure);
  assert.deepEqual(db.getSetting(SMART_REFRESH_POLICY_KEY), persistedBeforeFailure);
  response = await fetch(`${base}/api/settings/smart-refresh`, { method: "DELETE" });
  assert.equal(response.status, 500);
  assert.equal(appState.smartPolicy, policyBeforeFailure);
  assert.deepEqual(db.getSetting(SMART_REFRESH_POLICY_KEY), persistedBeforeFailure);
  failSet = false;
  failDelete = false;

  response = await fetch(`${base}/api/settings/smart-refresh`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, "environment");
  assert.equal(db.getSetting(SMART_REFRESH_POLICY_KEY), null);
  assert.equal(appState.smartPolicy, defaultPolicy);

  db.setSetting(SMART_REFRESH_POLICY_KEY, { rules: [{ id: "not valid" }] });
  const warnings = [];
  const loaded = loadSmartRefreshPolicy(db, defaultPolicy, {
    warn(message) { warnings.push(message); },
  });
  assert.equal(loaded.policy, defaultPolicy);
  assert.equal(loaded.source, "environment");
  assert.match(warnings[0], /invalid persisted smart refresh policy/);
});
