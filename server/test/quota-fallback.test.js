const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const Db = require("../lib/db");
const { QuotaLedger } = require("../lib/quota");
const { DEFAULT_POLICY } = require("../lib/refresh-policy");
const { isRssFallbackErrorCode, refreshChannels } = require("../lib/refresh");

function channelId(index) {
  return `UC${index.toString(36).padStart(22, "0")}`;
}

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-fallback-"));
  const db = new Db(path.join(dir, "wadstube.db"));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db };
}

function seed(db, ids) {
  for (const [index, id] of ids.entries()) db.upsertChannel(id, `Channel ${index}`);
}

function rssNotModified() {
  return { status: 304, ok: false };
}

function apiError(reason, message = reason) {
  return {
    status: 403,
    ok: false,
    statusText: "Forbidden",
    json: async () => ({ error: { errors: [{ reason, message }] } }),
  };
}

test("manual API preflight switches the whole due run to RSS instead of returning 429", async (t) => {
  const { dir, db } = tempDb(t);
  const ids = [channelId(1), channelId(2)];
  const data = {
    version: 1,
    folders: [{
      id: "all-channels", name: "All", children: [],
      channels: ids.map((id, index) => ({ id, name: `Channel ${index}`, addedAt: "2026-01-01" })),
    }],
  };
  let preflightCount = null;
  let apiRequests = 0;
  let rssRequests = 0;
  const request = global.fetch;
  const quota = {
    assertCanSpend(_bucket, count) {
      preflightCount = count;
      const err = new Error("daily budget is too small");
      err.code = "quotaBudgetExceeded";
      throw err;
    },
    status() {
      return { buckets: { general: { used: 9999, limit: 10000, remaining: 1 } } };
    },
  };
  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("/playlistItems?")) apiRequests++;
    if (String(url).includes("/feeds/videos.xml?")) {
      rssRequests++;
      return rssNotModified();
    }
    throw new Error(`Unexpected request ${url}`);
  });

  const appState = {
    data, dataDir: dir, db, quota, apiKey: "key", manualMode: "api",
    maxVideos: 50, smartPolicy: DEFAULT_POLICY, refreshLock: null,
  };
  const app = express();
  app.use("/api/refresh", require("../routes/refresh")(appState));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(`http://127.0.0.1:${server.address().port}/api/refresh`, { method: "POST" });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  const summary = events.find((event) => event.type === "summary");
  assert.equal(preflightCount, 2);
  assert.equal(apiRequests, 0);
  assert.equal(rssRequests, 2);
  assert.equal(summary.requested_mode, "api");
  assert.equal(summary.effective_mode, "rss");
  assert.equal(summary.rss_fallbacks, 2);
  assert.equal(summary.rss_requests, 2);
  assert.equal(summary.fallback_reason, "quotaBudgetExceeded");
  assert.equal(summary.errors, 0);
  const run = db.listRefreshRuns(1)[0];
  assert.equal(run.requested_mode, "api");
  assert.equal(run.effective_mode, "rss");
  assert.equal(run.rss_fallbacks, 2);
  assert.equal(run.fallback_reason, "quotaBudgetExceeded");
});

test("local quota exhaustion falls back through an RSS pool capped at five", async (t) => {
  const { db } = tempDb(t);
  const ids = Array.from({ length: 12 }, (_, index) => channelId(index + 10));
  seed(db, ids);
  let activeRss = 0;
  let maxActiveRss = 0;
  let reserveCalls = 0;
  const quota = {
    reserve() {
      reserveCalls++;
      const err = new Error("local quota exhausted");
      err.code = "quotaBudgetExceeded";
      throw err;
    },
    status() {
      return { buckets: { general: { used: 10000, limit: 10000, remaining: 0 } } };
    },
  };
  t.mock.method(global, "fetch", async (url) => {
    assert.match(String(url), /feeds\/videos\.xml/);
    activeRss++;
    maxActiveRss = Math.max(maxActiveRss, activeRss);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRss--;
    return rssNotModified();
  });

  const summary = await refreshChannels(db, ids, {
    mode: "api", apiKey: "key", quota, policy: DEFAULT_POLICY,
    trigger: "manual-retry", scope: "local-quota",
  });
  assert.ok(reserveCalls >= 1);
  assert.equal(summary.checked, ids.length);
  assert.equal(summary.errors, 0);
  assert.equal(summary.api_calls, 0);
  assert.equal(summary.rss_fallbacks, ids.length);
  assert.equal(summary.rss_requests, ids.length);
  assert.equal(summary.effective_mode, "rss");
  assert.equal(summary.fallback_reason, "quotaBudgetExceeded");
  assert.ok(maxActiveRss <= 5, `RSS concurrency reached ${maxActiveRss}`);
});

test("single-channel retry falls back to RSS when its API reservation is rejected", async (t) => {
  const { dir, db } = tempDb(t);
  const id = channelId(40);
  const request = global.fetch;
  const quota = {
    reserve() {
      const err = new Error("local quota exhausted");
      err.code = "quotaBudgetExceeded";
      throw err;
    },
    status() {
      return { buckets: { general: { used: 10000, limit: 10000, remaining: 0 } } };
    },
  };
  let rssRequests = 0;
  t.mock.method(global, "fetch", async (url) => {
    assert.match(String(url), /feeds\/videos\.xml/);
    rssRequests++;
    return rssRequests === 1 ? { status: 500, ok: false } : rssNotModified();
  });
  const appState = {
    data: {
      version: 1,
      folders: [{
        id: "retry", name: "Retry", children: [],
        channels: [{ id, name: "Retry me", addedAt: "2026-01-01" }],
      }],
    },
    dataDir: dir,
    db,
    quota,
    apiKey: "key",
    manualMode: "api",
    maxVideos: 50,
    smartPolicy: DEFAULT_POLICY,
    refreshLock: null,
  };
  const app = express();
  app.use("/api/channels", require("../routes/channels")(appState));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(
    `http://127.0.0.1:${server.address().port}/api/channels/${id}/refresh`,
    { method: "POST" },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.summary.checked, 1);
  assert.equal(body.summary.rss_fallbacks, 1);
  assert.equal(body.summary.rss_requests, 2);
  assert.ok(body.summary.rss_requests > body.summary.rss_fallbacks);
  assert.equal(body.summary.effective_mode, "rss");
  assert.equal(body.summary.fallback_reason, "quotaBudgetExceeded");
});

test("a throwing fallback RSS response still reports the redirected channel", async (t) => {
  const { db } = tempDb(t);
  const id = channelId(45);
  seed(db, [id]);
  const quota = {
    reserve() {
      const err = new Error("local quota exhausted");
      err.code = "quotaBudgetExceeded";
      throw err;
    },
    status() {
      return { buckets: { general: { used: 10000, limit: 10000, remaining: 0 } } };
    },
  };
  t.mock.method(global, "fetch", async (url) => {
    assert.match(String(url), /feeds\/videos\.xml/);
    return {
      status: 200,
      ok: true,
      text: async () => "<",
      headers: { get: () => null },
    };
  });

  const summary = await refreshChannels(db, [id], {
    mode: "api", apiKey: "key", quota, trigger: "manual-retry", scope: id,
  });
  assert.equal(summary.checked, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.rss_fallbacks, 1);
  assert.equal(summary.rss_requests, 1);
  assert.equal(summary.effective_mode, "rss");
  assert.equal(summary.fallback_reason, "quotaBudgetExceeded");
});

test("an API run continues through RSS when the local ledger becomes exhausted mid-run", async (t) => {
  const { db } = tempDb(t);
  const ids = Array.from({ length: 4 }, (_, index) => channelId(index + 50));
  seed(db, ids);
  const quota = new QuotaLedger(db, { limits: { general: 1, search: 10 } });
  let apiRequests = 0;
  let rssRequests = 0;
  t.mock.method(global, "fetch", async (url) => {
    const value = String(url);
    if (value.includes("/playlistItems?")) {
      apiRequests++;
      return { status: 200, ok: true, json: async () => ({ items: [] }) };
    }
    if (value.includes("/feeds/videos.xml?")) {
      rssRequests++;
      return rssNotModified();
    }
    throw new Error(`Unexpected request ${value}`);
  });

  const summary = await refreshChannels(db, ids, {
    mode: "api", apiKey: "key", quota, policy: DEFAULT_POLICY,
    trigger: "manual", scope: "local-mid-run",
  });
  assert.equal(apiRequests, 1);
  assert.equal(rssRequests, ids.length - 1);
  assert.equal(summary.api_calls, 1);
  assert.equal(summary.api_units, 1);
  assert.equal(summary.rss_fallbacks, ids.length - 1);
  assert.equal(summary.effective_mode, "api+rss");
  assert.equal(summary.fallback_reason, "quotaBudgetExceeded");
  assert.equal(summary.errors, 0);
});

test("remote quota response trips the shared breaker so later channels skip API", async (t) => {
  const { db } = tempDb(t);
  const ids = Array.from({ length: 25 }, (_, index) => channelId(index + 100));
  seed(db, ids);
  const quota = new QuotaLedger(db, { limits: { general: 100, search: 10 } });
  let apiRequests = 0;
  let rssRequests = 0;
  t.mock.method(global, "fetch", async (url) => {
    const value = String(url);
    if (value.includes("/playlistItems?")) {
      apiRequests++;
      return apiError("quotaExceeded");
    }
    if (value.includes("/feeds/videos.xml?")) {
      rssRequests++;
      return rssNotModified();
    }
    throw new Error(`Unexpected request ${value}`);
  });

  const summary = await refreshChannels(db, ids, {
    mode: "api", apiKey: "key", quota, policy: DEFAULT_POLICY,
    trigger: "manual", scope: "remote-quota",
  });
  assert.ok(apiRequests > 0);
  assert.ok(apiRequests < ids.length, `${apiRequests} API calls did not show breaker short-circuiting`);
  assert.equal(rssRequests, ids.length);
  assert.equal(summary.api_calls, apiRequests);
  assert.equal(summary.rss_fallbacks, ids.length);
  assert.equal(summary.rss_requests, ids.length);
  assert.equal(summary.effective_mode, "api+rss");
  assert.equal(summary.fallback_reason, "quotaExceeded");
  assert.equal(summary.errors, 0);
});

test("non-quota structured API failures stay errors and never use RSS", async (t) => {
  const { db } = tempDb(t);
  const id = channelId(500);
  seed(db, [id]);
  const quota = new QuotaLedger(db, { limits: { general: 100, search: 10 } });
  let rssRequests = 0;
  t.mock.method(global, "fetch", async (url) => {
    if (String(url).includes("/playlistItems?")) return apiError("forbidden");
    rssRequests++;
    return rssNotModified();
  });

  const summary = await refreshChannels(db, [id], {
    mode: "api", apiKey: "key", quota, trigger: "manual-retry", scope: id,
  });
  assert.equal(summary.checked, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.rss_fallbacks, 0);
  assert.equal(summary.rss_requests, 0);
  assert.equal(summary.effective_mode, "api");
  assert.equal(summary.fallback_reason, null);
  assert.equal(rssRequests, 0);
});

test("fallback eligibility uses exact structured codes only", () => {
  for (const code of [
    "quotaBudgetExceeded", "quotaExceeded", "dailyLimitExceeded",
    "rateLimitExceeded", "userRateLimitExceeded",
  ]) assert.equal(isRssFallbackErrorCode(code), true, code);
  for (const code of [
    "forbidden", "notFound", "youtubeUnavailable", "apiKeyRequired",
    "quota exceeded", "quotaExceededBecauseMessageMatched", null,
  ]) assert.equal(isRssFallbackErrorCode(code), false, String(code));
});
