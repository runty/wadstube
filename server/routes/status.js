const express = require("express");
const packageInfo = require("../package.json");
const { buildRefreshPlan, apiRefreshUnitsForChannels } = require("../lib/refresh-plan");
const { shiftQuotaDay, QUOTA_TZ } = require("../lib/quota");
const { isResolvedChannel } = require("../lib/data");
const { listBackupDetails, verifyBackup } = require("../lib/backup");
const { rateLimit } = require("../lib/security");

function boundedInteger(value, { fallback, min, max, label }) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function subscriptionCounts(data) {
  const uniqueResolved = new Set();
  let memberships = 0;
  let unresolved = 0;
  function walk(folders) {
    for (const folder of folders || []) {
      for (const channel of folder.channels || []) {
        memberships++;
        if (isResolvedChannel(channel)) uniqueResolved.add(channel.id);
        else unresolved++;
      }
      walk(folder.children);
    }
  }
  walk(data?.folders);
  return {
    memberships,
    resolvedMemberships: memberships - unresolved,
    unresolvedMemberships: unresolved,
    uniqueResolvedChannels: uniqueResolved.size,
  };
}

function quotaHistory(appState, days, { includeCurrent = true } = {}) {
  const current = appState.quota.status();
  const endDay = shiftQuotaDay(current.quotaDay, includeCurrent ? 0 : -1);
  const startDay = shiftQuotaDay(endDay, -(days - 1));
  const rows = appState.db.getApiUsageRange(startDay, endDay);
  const byDay = new Map();
  for (const row of rows) {
    const value = byDay.get(row.quota_day) || [];
    value.push(row);
    byDay.set(row.quota_day, value);
  }
  const history = [];
  for (let offset = 0; offset < days; offset++) {
    const day = shiftQuotaDay(startDay, offset);
    const endpoints = byDay.get(day) || [];
    const buckets = {};
    for (const [name, currentBucket] of Object.entries(current.buckets)) {
      const matching = endpoints.filter((row) => row.bucket === name);
      buckets[name] = {
        calls: matching.reduce((sum, row) => sum + row.calls, 0),
        units: matching.reduce((sum, row) => sum + row.units, 0),
        limit: currentBucket.limit,
      };
    }
    history.push({ quotaDay: day, buckets, endpoints });
  }
  return { timezone: QUOTA_TZ, startDay, endDay, days, history };
}

function completeDayAverage(appState, days = 7) {
  const range = quotaHistory(appState, days, { includeCurrent: false });
  const totals = {};
  for (const day of range.history) {
    for (const [bucket, value] of Object.entries(day.buckets)) {
      totals[bucket] ||= { calls: 0, units: 0 };
      totals[bucket].calls += value.calls;
      totals[bucket].units += value.units;
    }
  }
  const buckets = Object.fromEntries(Object.entries(totals).map(([name, value]) => [name, {
    averageCalls: Number((value.calls / days).toFixed(2)),
    averageUnits: Number((value.units / days).toFixed(2)),
    totalCalls: value.calls,
    totalUnits: value.units,
  }]));
  return {
    days,
    completeDaysOnly: true,
    startDay: range.startDay,
    endDay: range.endDay,
    buckets,
  };
}

function systemHealth(appState) {
  const now = new Date();
  const uptimeSeconds = Math.floor(process.uptime());
  const startedAt = appState.startedAt ||
    new Date(now.getTime() - process.uptime() * 1000).toISOString();
  return {
    ok: true,
    checkedAt: now.toISOString(),
    version: appState.version || process.env.WADSTUBE_VERSION || packageInfo.version || "unknown",
    process: { startedAt, uptimeSeconds },
    refresh: {
      locked: !!appState.refreshLock,
      activeTasks: appState.activeTasks?.size || 0,
      defaultMode: appState.defaultMode || appState.manualMode || "rss",
      manualMode: appState.manualMode || "rss",
      intervalMinutes: appState.refreshIntervalMinutes ?? 0,
      policySource: appState.smartPolicySource || "environment",
    },
    database: {
      ...(appState.db.getSystemStats?.() || appState.db.getStats()),
      ...appState.db.getStorageStats(),
    },
    subscriptions: subscriptionCounts(appState.data),
    backup: appState.backupController?.status?.() || {
      scheduled: false,
      running: false,
      nextRunAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    },
  };
}

module.exports = function statusRoutes(appState) {
  const router = express.Router();
  const databaseCheckLimit = rateLimit({
    windowMs: 60_000, max: 3, name: "database integrity check",
  });
  const backupVerifyLimit = rateLimit({
    windowMs: 60_000, max: 10, name: "backup verification",
  });

  router.get("/quota", (_req, res) => {
    res.json(appState.quota.status());
  });
  router.get("/quota/history", (req, res) => {
    try {
      const days = boundedInteger(req.query.days, {
        fallback: 30, min: 1, max: 90, label: "days",
      });
      res.json({
        current: appState.quota.status(),
        ...quotaHistory(appState, days),
      });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  router.get("/quota/forecast", (_req, res) => {
    try {
      const plan = buildRefreshPlan(appState);
      res.json({
        generatedAt: new Date().toISOString(),
        timezone: QUOTA_TZ,
        current: appState.quota.status(),
        completeDayAverage: completeDayAverage(appState, 7),
        snapshot: {
          kind: "current-eligibility-snapshot",
          dueChannels: plan.channels.due,
          requestedMode: plan.mode.requested,
          effectiveMode: plan.mode.effective,
          fallbackReason: plan.mode.fallbackReason,
          apiUnitsRequiredForApiMode:
            apiRefreshUnitsForChannels(plan.channels.due),
          expectedApiUnitsIfRunNow:
            plan.mode.effective === "api"
              ? apiRefreshUnitsForChannels(plan.channels.due)
              : 0,
          fullPass: {
            channelCount: plan.fullPass.channelCount,
            projectedApiUnits: plan.fullPass.projectedApiUnits,
            currentRemaining: plan.fullPass.currentRemaining,
            canCover: plan.fullPass.canCover,
            completePassesRemaining: plan.fullPass.completePassesRemaining,
          },
        },
        timeProjection: null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.get("/refresh-runs", (req, res) => {
    res.json(appState.db.listRefreshRuns(req.query.limit));
  });
  router.get("/refresh", (_req, res) => {
    res.json({
      running: !!appState.refreshLock,
      quota: appState.quota.status(),
      recentRuns: appState.db.listRefreshRuns(10),
    });
  });
  router.get("/system", (_req, res) => {
    try { res.json(systemHealth(appState)); }
    catch (err) { res.status(500).json({ error: `System health failed: ${err.message}` }); }
  });
  router.post("/system/database-check", databaseCheckLimit, (_req, res) => {
    const started = process.hrtime.bigint();
    try {
      const result = appState.db.quickCheck();
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      res.status(result === "ok" ? 200 : 503).json({
        ok: result === "ok", result, checkedAt: new Date().toISOString(),
        durationMs: Number(durationMs.toFixed(2)),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  router.get("/backups", (req, res) => {
    try {
      const limit = boundedInteger(req.query.limit, {
        fallback: 30, min: 1, max: 100, label: "limit",
      });
      const backups = listBackupDetails(appState.dataDir, limit);
      res.json({ backups, count: backups.length, limit });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  router.post("/backups/:date/verify", backupVerifyLimit, (req, res) => {
    try {
      const { directory: _directory, ...result } = verifyBackup(appState.dataDir, req.params.date);
      res.json({ ...result, verifiedAt: new Date().toISOString() });
    } catch (err) {
      const status = err.status || (/date|path/i.test(err.message) ? 400 : 422);
      res.status(status).json({ error: err.message });
    }
  });
  return router;
};

module.exports.boundedInteger = boundedInteger;
module.exports.subscriptionCounts = subscriptionCounts;
module.exports.quotaHistory = quotaHistory;
module.exports.completeDayAverage = completeDayAverage;
module.exports.systemHealth = systemHealth;
