const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_POLICY = Object.freeze({
  noHistoryIntervalHours: 24,
  newUploadCooldownHours: 2,
  failureRetryMinutes: Object.freeze([5, 15, 30, 60]),
  rules: Object.freeze([
    Object.freeze({
      id: "return_after_3_months",
      label: "Returned after 3 months",
      minUploadAgeDays: 90,
      minRefreshIntervalHours: 6,
    }),
    Object.freeze({
      id: "return_after_1_year",
      label: "Returned after 1 year",
      minUploadAgeDays: 365,
      minRefreshIntervalHours: 24,
    }),
  ]),
});

function finitePositive(value, name, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} number`);
  }
  return number;
}

function validatePolicy(input = DEFAULT_POLICY) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Smart refresh policy must be a JSON object");
  }
  const noHistoryIntervalHours = finitePositive(
    input.noHistoryIntervalHours ?? DEFAULT_POLICY.noHistoryIntervalHours,
    "noHistoryIntervalHours",
  );
  const newUploadCooldownHours = finitePositive(
    input.newUploadCooldownHours ?? DEFAULT_POLICY.newUploadCooldownHours,
    "newUploadCooldownHours",
  );
  const rawRetries = input.failureRetryMinutes ?? DEFAULT_POLICY.failureRetryMinutes;
  if (!Array.isArray(rawRetries) || !rawRetries.length || rawRetries.length > 20) {
    throw new Error("failureRetryMinutes must be a non-empty array with at most 20 entries");
  }
  const failureRetryMinutes = rawRetries.map((value, index) =>
    finitePositive(value, `failureRetryMinutes[${index}]`));
  const rawRules = input.rules ?? DEFAULT_POLICY.rules;
  if (!Array.isArray(rawRules)) throw new Error("Smart refresh policy rules must be an array");
  const ids = new Set();
  const rules = rawRules.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`Smart refresh rule ${index + 1} must be an object`);
    }
    const id = String(rule.id || "").trim();
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(id)) {
      throw new Error(`Smart refresh rule ${index + 1} has an invalid id`);
    }
    if (ids.has(id)) throw new Error(`Duplicate smart refresh rule id "${id}"`);
    ids.add(id);
    return Object.freeze({
      id,
      label: String(rule.label || id).trim().slice(0, 100),
      minUploadAgeDays: finitePositive(rule.minUploadAgeDays, `${id}.minUploadAgeDays`, { allowZero: true }),
      minRefreshIntervalHours: finitePositive(rule.minRefreshIntervalHours, `${id}.minRefreshIntervalHours`),
    });
  });
  return Object.freeze({
    noHistoryIntervalHours,
    newUploadCooldownHours,
    failureRetryMinutes: Object.freeze(failureRetryMinutes),
    rules: Object.freeze(rules),
  });
}

function loadPolicy(value = process.env.SMART_REFRESH_POLICY_JSON) {
  if (!value) return validatePolicy(DEFAULT_POLICY);
  let parsed;
  try { parsed = JSON.parse(value); }
  catch (err) { throw new Error(`SMART_REFRESH_POLICY_JSON is invalid JSON: ${err.message}`); }
  return validatePolicy(parsed);
}

function strongestMatchingRule(latestUploadAt, now = new Date(), policy = DEFAULT_POLICY) {
  if (!latestUploadAt) return null;
  const uploaded = new Date(latestUploadAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(uploaded) || !Number.isFinite(current)) return null;
  const ageMs = Math.max(0, current - uploaded);
  const matches = policy.rules.filter((rule) => ageMs >= rule.minUploadAgeDays * DAY_MS);
  if (!matches.length) return null;
  return matches.reduce((strongest, rule) => {
    if (!strongest) return rule;
    if (rule.minRefreshIntervalHours !== strongest.minRefreshIntervalHours) {
      return rule.minRefreshIntervalHours > strongest.minRefreshIntervalHours ? rule : strongest;
    }
    return rule.minUploadAgeDays > strongest.minUploadAgeDays ? rule : strongest;
  }, null);
}

function evaluateRefresh(meta, {
  now = new Date(),
  policy = DEFAULT_POLICY,
  baseIntervalMinutes = 30,
  force = false,
} = {}) {
  const currentMs = new Date(now).getTime();
  if (force) return { due: true, forced: true, reason: "manual_force", rule: null, nextDueAt: new Date(currentMs).toISOString() };
  if (meta?.last_refresh_status === "error" && meta.last_refresh_attempt_at) {
    const attemptMs = new Date(meta.last_refresh_attempt_at).getTime();
    if (Number.isFinite(attemptMs)) {
      const failures = Math.max(1, Number(meta.consecutive_failures) || 1);
      const index = Math.min(failures - 1, policy.failureRetryMinutes.length - 1);
      const retryMinutes = policy.failureRetryMinutes[index];
      const nextDueMs = attemptMs + retryMinutes * 60_000;
      return {
        due: currentMs >= nextDueMs,
        forced: false,
        reason: "failure_backoff",
        rule: null,
        retryMinutes,
        intervalHours: retryMinutes / 60,
        nextDueAt: new Date(nextDueMs).toISOString(),
      };
    }
  }
  if (!meta?.last_refreshed_at) {
    return { due: true, forced: false, reason: "never_refreshed", rule: null, nextDueAt: new Date(currentMs).toISOString() };
  }

  const lastMs = new Date(meta.last_refreshed_at).getTime();
  if (!Number.isFinite(lastMs)) {
    return { due: true, forced: false, reason: "invalid_last_refresh", rule: null, nextDueAt: new Date(currentMs).toISOString() };
  }
  const rule = strongestMatchingRule(meta.latest_upload_at, now, policy);
  const configuredBaseMinutes = Number(baseIntervalMinutes);
  const normalIntervalMinutes = Number.isFinite(configuredBaseMinutes)
    ? Math.max(0, configuredBaseMinutes)
    : 30;
  const intervalMs = rule
    ? rule.minRefreshIntervalHours * HOUR_MS
    : meta.last_refresh_had_upload
      ? policy.newUploadCooldownHours * HOUR_MS
    : meta.latest_upload_at
      ? normalIntervalMinutes * 60_000
      : policy.noHistoryIntervalHours * HOUR_MS;
  const nextDueMs = lastMs + intervalMs;
  return {
    due: currentMs >= nextDueMs,
    forced: false,
    reason: rule?.id || (meta.last_refresh_had_upload
      ? "new_upload_cooldown"
      : meta.latest_upload_at ? "normal_cadence" : "no_upload_history"),
    rule,
    intervalHours: intervalMs / HOUR_MS,
    nextDueAt: new Date(nextDueMs).toISOString(),
  };
}

function filterDueChannels(rows, options = {}) {
  const due = [];
  const skipped = [];
  for (const row of rows) {
    const evaluation = evaluateRefresh(row, options);
    (evaluation.due ? due : skipped).push({ ...row, refresh_policy: evaluation });
  }
  return { due, skipped };
}

module.exports = {
  HOUR_MS,
  DAY_MS,
  DEFAULT_POLICY,
  validatePolicy,
  loadPolicy,
  strongestMatchingRule,
  evaluateRefresh,
  filterDueChannels,
};
