import test from "node:test";
import assert from "node:assert/strict";

const operations = await import("../src/stores/operations.js");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

test("preview formatting and smart-policy drafts are deterministic and validated", () => {
  assert.equal(operations.formatReason("new_upload_cooldown"), "New Upload Cooldown");
  const draft = operations.policyToDraft({
    noHistoryIntervalHours: 24, newUploadCooldownHours: 2,
    failureRetryMinutes: [5, 15],
    rules: [{ id: "return_after_year", label: "One year", minUploadAgeDays: 365, minRefreshIntervalHours: 24 }],
  });
  assert.equal(draft.failureRetryMinutes, "5, 15");
  assert.deepEqual(operations.draftToPolicy(draft), {
    noHistoryIntervalHours: 24, newUploadCooldownHours: 2,
    failureRetryMinutes: [5, 15],
    rules: [{ id: "return_after_year", label: "One year", minUploadAgeDays: 365, minRefreshIntervalHours: 24 }],
  });
  assert.throws(() => operations.draftToPolicy({ ...draft, failureRetryMinutes: "0" }), /greater than zero/);
  assert.throws(() => operations.draftToPolicy({ ...draft, rules: [...draft.rules, { ...draft.rules[0] }] }), /duplicated/);
});

test("health filtering, inactivity buckets, sorting, and folder flattening are pure", () => {
  const now = Date.parse("2026-07-19T00:00:00Z");
  const rows = [
    { id: "a", title: "Alpha", latest_upload_at: null, last_refresh_status: "error", last_refreshed_at: "2026-07-01", smart_refresh: { due: true, nextDueAt: "2026-07-19" } },
    { id: "b", title: "Beta", latest_upload_at: "2026-03-01", last_refresh_status: "ok", last_refreshed_at: "2026-07-18", smart_refresh: { due: false, nextDueAt: "2026-07-20" } },
    { id: "c", title: "Gamma", latest_upload_at: "2025-01-01", last_refresh_status: "ok", last_refreshed_at: "2026-06-01", smart_refresh: { due: true, nextDueAt: "2026-07-18" } },
  ];
  assert.deepEqual(operations.filterAndSortHealth(rows, { inactivity: "none" }, now).map((row) => row.id), ["a"]);
  assert.deepEqual(operations.filterAndSortHealth(rows, { inactivity: "90to364" }, now).map((row) => row.id), ["b"]);
  assert.deepEqual(operations.filterAndSortHealth(rows, { inactivity: "365plus" }, now).map((row) => row.id), ["c"]);
  assert.deepEqual(operations.filterAndSortHealth(rows, { due: "due", sort: "success" }, now).map((row) => row.id), ["a", "c"]);
  assert.deepEqual(operations.filterAndSortHealth(rows, { sort: "nextDue" }, now).map((row) => row.id), ["c", "a", "b"]);
  assert.deepEqual(
    operations.filterAndSortHealth([...rows, { id: "d", title: "Delta", last_refresh_status: "not_modified", smart_refresh: {} }], { status: "ok" }, now).map((row) => row.id),
    ["b", "d", "c"],
  );
  assert.deepEqual(operations.listFolderOptions([{ id: "root", name: "Root", children: [{ id: "child", name: "Child", children: [] }] }]), [
    { id: "root", name: "Root", label: "Root" }, { id: "child", name: "Child", label: "— Child" },
  ]);
  assert.equal(rows[0].title, "Alpha");
});

test("bulk selection is capped, clearable, and custom rule ids remain collision-free", () => {
  const selected = new Set(Array.from({ length: 10 }, (_, index) => `existing-${index}`));
  const visible = Array.from({ length: 600 }, (_, index) => `visible-${index}`);
  const capped = operations.selectVisibleIds(selected, visible);
  assert.equal(capped.size, operations.MAX_BULK_CHANNELS);
  assert.equal(capped.has("visible-489"), true);
  assert.equal(capped.has("visible-490"), false);
  assert.deepEqual([...operations.selectVisibleIds(new Set(visible.slice(0, 3)), visible.slice(0, 3))], []);
  assert.equal(operations.nextRuleId([{ id: "custom_rule_1" }, { id: "custom_rule_3" }]), "custom_rule_2");
});

test("all-return acknowledgement drains live 5000-id batches without claiming a frozen total", async () => {
  const firstIds = Array.from({ length: 5000 }, (_, index) => `video-${index}`);
  let remaining = 5001;
  let posts = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === "POST") {
      const ids = JSON.parse(options.body).videoIds;
      posts++;
      remaining -= ids.length;
      return json({ acknowledged: ids.length });
    }
    return json(remaining ? { count: remaining, videoIds: ["last-video"] } : { count: 0, videoIds: [] });
  };
  const complete = await operations.acknowledgeAllReturnBatches({}, {
    initial: { count: 5001, videoIds: firstIds },
  });
  assert.deepEqual(complete, { complete: true, acknowledged: 5001, batches: 2, initialCount: 5001, remaining: 0, error: null });
  assert.equal(posts, 2);

  let stage = 0;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === "POST") {
      stage++;
      return stage === 1 ? json({ acknowledged: 5000 }) : json({ error: "temporarily unavailable" }, 503);
    }
    return json({ count: 1, videoIds: ["last-video"] });
  };
  const partial = await operations.acknowledgeAllReturnBatches({}, {
    initial: { count: 5001, videoIds: firstIds },
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.acknowledged, 5000);
  assert.equal(partial.remaining, 1);
  assert.match(partial.error, /temporarily unavailable/);

  let liveRemaining = 0;
  let livePosts = 0;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === "POST") {
      livePosts++;
      liveRemaining = livePosts === 1 ? 1 : 0;
      return json({ acknowledged: 1 });
    }
    return json(liveRemaining ? { count: liveRemaining, videoIds: [`live-${liveRemaining}`] } : { count: 0, videoIds: [] });
  };
  const liveDrain = await operations.acknowledgeAllReturnBatches({}, {
    initial: { count: 1, videoIds: ["initial"] },
  });
  assert.equal(liveDrain.initialCount, 1);
  assert.equal(liveDrain.acknowledged, 2, "a return arriving during the drain is truthfully included");
  assert.equal(liveDrain.complete, true);
});

test("latest request generation ignores out-of-order results and aborts superseded work", async () => {
  const runLatest = operations.createLatestRequest();
  const resolvers = [];
  const signals = [];
  const applied = [];
  let settled = 0;
  const request = (label) => runLatest(
    (signal) => new Promise((resolve) => { signals.push(signal); resolvers.push(() => resolve(label)); }),
    { success: (value) => applied.push(value), settled: () => { settled++; } },
  );

  const older = request("older");
  const newer = request("newer");
  assert.equal(signals[0].aborted, true);
  resolvers[1]();
  await newer;
  resolvers[0]();
  const oldResult = await older;

  assert.deepEqual(applied, ["newer"]);
  assert.equal(settled, 1, "the superseded request cannot clear the latest loading state");
  assert.deepEqual(oldResult, { applied: false, stale: true });
});

test("operations APIs encode scopes and send one explicit bounded payload", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options?.method || "GET", body: options?.body ? JSON.parse(options.body) : null });
    return json({ ok: true, policy: {}, videoIds: ["v1"], count: 1, summary: {} });
  };
  await operations.loadRefreshPreview("folder one");
  await operations.loadSmartPolicy();
  await operations.saveSmartPolicy({ rules: [] });
  await operations.resetSmartPolicy();
  await operations.getReturns({ folder: "folder one", channelId: "chan", q: "needle", favorites: true, sort: "oldest" }, 5000);
  await operations.acknowledgeReturns(["v1"]);
  await operations.bulkRefresh(["c1", "c2"]);
  await operations.bulkFavorite(["c1"], true);
  await operations.bulkMove(["c1"], "source", "destination");
  await operations.bulkDelete(["c1"]);
  await operations.resolveSubscription("folder one", "legacy/url", "https://youtube.com/@name");

  assert.equal(calls[0].url, "/api/refresh/preview/folder%20one");
  assert.deepEqual(calls[2], { url: "/api/settings/smart-refresh", method: "PUT", body: { policy: { rules: [] } } });
  assert.match(calls[4].url, /folder=folder\+one/);
  assert.match(calls[4].url, /limit=5000/);
  assert.deepEqual(calls[5].body, { videoIds: ["v1"] });
  assert.deepEqual(calls[6].body, { channelIds: ["c1", "c2"] });
  assert.deepEqual(calls[7].body, { channelIds: ["c1"], favorite: true });
  assert.deepEqual(calls[8].body, { channelIds: ["c1"], sourceFolderId: "source", destinationFolderId: "destination" });
  assert.equal(calls[9].method, "DELETE");
  assert.equal(calls[10].url, "/api/folders/folder%20one/channels/legacy%2Furl/resolve");
  assert.deepEqual(calls[10].body, { urlOrId: "https://youtube.com/@name" });
});

test("dashboard formatters are bounded and readable", () => {
  assert.equal(operations.formatBytes(0), "0 B");
  assert.equal(operations.formatBytes(1536), "1.50 KB");
  assert.equal(operations.formatBytes(5 * 1024 * 1024), "5.00 MB");
  assert.equal(operations.formatBytes(-1), "Unknown");
  assert.equal(operations.formatDuration(59), "0m");
  assert.equal(operations.formatDuration(3661), "1h 1m");
  assert.equal(operations.formatDuration(90061), "1d 1h");
  assert.equal(operations.quotaBarPercent({ units: 25, limit: 100 }), 25);
  assert.equal(operations.quotaBarPercent({ units: 200, limit: 100 }), 100);
  assert.equal(operations.quotaBarPercent({ units: 5, limit: 0 }), 0);
  assert.deepEqual(operations.systemVideoCounts({ totalVideoCount: 120, visibleVideoCount: 95, videoCount: 999 }), {
    total: 120,
    visible: 95,
  });
  assert.deepEqual(operations.systemVideoCounts({}), { total: null, visible: null });
  assert.deepEqual(operations.systemVideoCounts({ totalVideoCount: null, visibleVideoCount: null }), { total: null, visible: null });
  assert.equal(operations.formatBackupLastSuccess(null), "Not run since startup");
  assert.equal(
    operations.formatBackupLastSuccess("2026-07-19T01:00:00Z", (value) => `formatted ${value}`),
    "formatted 2026-07-19T01:00:00Z",
  );
});

test("operations tabs load only their routes once on first activation", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return json({ ok: true, policy: {}, history: [], snapshot: {}, backups: [] });
  };
  const loadedTabs = new Set();
  const loaders = {
    rules: operations.loadSmartPolicy,
    quotaHistory: () => operations.loadQuotaHistory(30),
    quotaForecast: operations.loadQuotaForecast,
    system: operations.loadSystemStatus,
    backups: () => operations.loadBackups(30),
  };

  await operations.loadOperationsTab("rules", loadedTabs, loaders);
  assert.deepEqual(calls, ["/api/settings/smart-refresh"]);

  await operations.loadOperationsTab("rules", loadedTabs, loaders);
  assert.deepEqual(calls, ["/api/settings/smart-refresh"]);

  await operations.loadOperationsTab("quota", loadedTabs, loaders);
  assert.deepEqual(calls, [
    "/api/settings/smart-refresh",
    "/api/status/quota/history?days=30",
    "/api/status/quota/forecast",
  ]);

  await operations.loadOperationsTab("system", loadedTabs, loaders);
  await operations.loadOperationsTab("backups", loadedTabs, loaders);
  assert.deepEqual(calls.slice(-2), ["/api/status/system", "/api/status/backups?limit=30"]);
});

test("dashboard APIs use bounded status routes and preserve integrity-check results", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET" };
    calls.push(call);
    if (call.url === "/api/status/system/database-check") {
      return json({ ok: false, result: "database disk image is malformed", checkedAt: "2026-07-19T00:00:00Z", durationMs: 4 }, 503);
    }
    if (call.url === "/api/status/system") return json({ version: "test" });
    if (call.url.includes("/verify")) return json({ ok: true, date: "2026-07-19", quickCheck: "ok" });
    return json({ ok: true, history: [], backups: [], snapshot: {} });
  };

  await operations.loadQuotaHistory(14);
  await operations.loadQuotaForecast();
  assert.equal((await operations.loadSystemStatus()).version, "test");
  const check = await operations.runDatabaseCheck();
  assert.equal(check.ok, false);
  assert.match(check.result, /malformed/);
  await operations.loadBackups(30);
  await operations.verifyBackup("2026-07-19");

  assert.deepEqual(calls, [
    { url: "/api/status/quota/history?days=14", method: "GET" },
    { url: "/api/status/quota/forecast", method: "GET" },
    { url: "/api/status/system", method: "GET" },
    { url: "/api/status/system/database-check", method: "POST" },
    { url: "/api/status/backups?limit=30", method: "GET" },
    { url: "/api/status/backups/2026-07-19/verify", method: "POST" },
  ]);

  globalThis.fetch = async () => json({ error: "status offline" }, 503);
  await assert.rejects(() => operations.loadSystemStatus(), /status offline/);
});
