const QUOTA_TZ = "America/Los_Angeles";

const DEFAULT_LIMITS = Object.freeze({ general: 10_000, search: 100 });

function quotaDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: QUOTA_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addCalendarDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

function resetAtForDay(day) {
  const next = addCalendarDay(day);
  const [year, month, date] = next.split("-").map(Number);
  // Pacific midnight is always either 07:00Z or 08:00Z. Choose the
  // candidate whose formatted local date and clock are exactly midnight.
  for (const hour of [7, 8]) {
    const candidate = new Date(Date.UTC(year, month - 1, date, hour));
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: QUOTA_TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(candidate);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (`${value.year}-${value.month}-${value.day}` === next && value.hour === "00" && value.minute === "00") {
      return candidate.toISOString();
    }
  }
  throw new Error(`Could not determine Pacific quota reset for ${day}`);
}

function parseLimits(env = process.env) {
  const read = (name, fallback) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  return {
    general: read("YOUTUBE_QUOTA_GENERAL_LIMIT", DEFAULT_LIMITS.general),
    search: read("YOUTUBE_QUOTA_SEARCH_LIMIT", DEFAULT_LIMITS.search),
  };
}

function createRunMetrics({ trigger = "manual", mode = "rss", scope = "all", requestedChannels = 0 } = {}) {
  return {
    trigger,
    mode,
    scope,
    requested_channels: requestedChannels,
    started_at: new Date().toISOString(),
    api_calls: 0,
    api_units: 0,
    api_by_endpoint: {},
    rss_requests: 0,
    shorts_probes: 0,
  };
}

function recordNetwork(metrics, type) {
  if (!metrics) return;
  if (type === "rss") metrics.rss_requests++;
  if (type === "shorts") metrics.shorts_probes++;
}

class QuotaLedger {
  constructor(db, { limits = DEFAULT_LIMITS, now = () => new Date() } = {}) {
    this.db = db;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.now = now;
  }

  reserve(endpoint, { bucket = endpoint === "search.list" ? "search" : "general", units = 1, metrics = null } = {}) {
    const day = quotaDay(this.now());
    const limit = this.limits[bucket];
    if (!limit) throw new Error(`Unknown quota bucket "${bucket}"`);
    this.db.reserveApiUsage({ day, bucket, endpoint, units, limit });
    if (metrics) {
      metrics.api_calls++;
      metrics.api_units += units;
      const current = metrics.api_by_endpoint[endpoint] || { calls: 0, units: 0, bucket };
      current.calls++;
      current.units += units;
      metrics.api_by_endpoint[endpoint] = current;
    }
  }

  assertCanSpend(bucket, units) {
    const status = this.status();
    const found = status.buckets[bucket];
    if (!found || units > found.remaining) {
      const err = new Error(`YouTube ${bucket} quota budget cannot cover ${units} request${units === 1 ? "" : "s"}; ${found?.remaining ?? 0} remain`);
      err.code = "quotaBudgetExceeded";
      throw err;
    }
  }

  status() {
    const day = quotaDay(this.now());
    const usage = this.db.getApiUsage(day);
    const buckets = {};
    for (const [name, limit] of Object.entries(this.limits)) {
      const used = usage.filter((row) => row.bucket === name).reduce((sum, row) => sum + row.units, 0);
      buckets[name] = { used, limit, remaining: Math.max(0, limit - used) };
    }
    return { quotaDay: day, timezone: QUOTA_TZ, resetAt: resetAtForDay(day), buckets, endpoints: usage };
  }
}

module.exports = {
  QUOTA_TZ,
  DEFAULT_LIMITS,
  quotaDay,
  resetAtForDay,
  parseLimits,
  createRunMetrics,
  recordNetwork,
  QuotaLedger,
};
