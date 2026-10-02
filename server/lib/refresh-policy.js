const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// These limits are intentionally far above useful refresh settings while
// keeping every interval and upload-age calculation comfortably inside the
// JavaScript Date range.
const MAX_REFRESH_INTERVAL_HOURS = 24 * 365;
const MAX_UPLOAD_AGE_DAYS = 365 * 100;
const MAX_FAILURE_RETRY_MINUTES = 60 * 24 * 30;

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

function finitePositive(value, name, { allowZero = false, max } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} number`);
  }
  if (number > max) throw new Error(`${name} must be at most ${max}`);
  return number;
}

function validatePolicy(input = DEFAULT_POLICY) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Smart refresh policy must be a JSON object");
  }
  const noHistoryIntervalHours = finitePositive(
    input.noHistoryIntervalHours ?? DEFAULT_POLICY.noHistoryIntervalHours,
    "noHistoryIntervalHours",
    { max: MAX_REFRESH_INTERVAL_HOURS },
  );
  const newUploadCooldownHours = finitePositive(
    input.newUploadCooldownHours ?? DEFAULT_POLICY.newUploadCooldownHours,
    "newUploadCooldownHours",
    { max: MAX_REFRESH_INTERVAL_HOURS },
  );
  const rawRetries = input.failureRetryMinutes ?? DEFAULT_POLICY.failureRetryMinutes;
  if (!Array.isArray(rawRetries) || !rawRetries.length || rawRetries.length > 20) {
    throw new Error("failureRetryMinutes must be a non-empty array with at most 20 entries");
  }
  const failureRetryMinutes = rawRetries.map((value, index) =>
    finitePositive(value, `failureRetryMinutes[${index}]`, {
      max: MAX_FAILURE_RETRY_MINUTES,
    }));
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
      minUploadAgeDays: finitePositive(rule.minUploadAgeDays, `${id}.minUploadAgeDays`, {
        allowZero: true, max: MAX_UPLOAD_AGE_DAYS,
      }),
      minRefreshIntervalHours: finitePositive(rule.minRefreshIntervalHours, `${id}.minRefreshIntervalHours`, {
        max: MAX_REFRESH_INTERVAL_HOURS,
      }),
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

// Every explicit refresh is eligible immediately. Legacy interval settings are
// still accepted for saved-policy compatibility, but cannot delay a channel.
function evaluateRefresh(_meta, {
  now = new Date(),
  muted = false,
  force = false,
} = {}) {
  return {
    due: !muted,
    forced: force && !muted,
    reason: muted ? "muted_folder" : force ? "manual_force" : "manual_refresh",
    rule: null,
    intervalHours: 0,
    nextDueAt: muted ? null : new Date(now).toISOString(),
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
  MAX_REFRESH_INTERVAL_HOURS,
  MAX_UPLOAD_AGE_DAYS,
  MAX_FAILURE_RETRY_MINUTES,
  DEFAULT_POLICY,
  validatePolicy,
  loadPolicy,
  strongestMatchingRule,
  evaluateRefresh,
  filterDueChannels,
};
