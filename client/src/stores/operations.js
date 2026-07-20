const API = "";

async function jsonRequest(url, options) {
  const response = await fetch(`${API}${url}`, options);
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function scopeParams(scope = {}) {
  const params = new URLSearchParams();
  if (scope.folder && scope.folder !== "__all__") params.set("folder", scope.folder);
  if (scope.channelId) params.set("channel", scope.channelId);
  if (scope.q) params.set("q", scope.q);
  if (scope.favorites) params.set("favorites", "1");
  if (scope.sort && scope.sort !== "newest") params.set("sort", scope.sort);
  return params;
}

export function loadRefreshPreview(folder) {
  return jsonRequest(folder && folder !== "__all__"
    ? `/api/refresh/preview/${encodeURIComponent(folder)}`
    : "/api/refresh/preview");
}

export const loadSmartPolicy = () => jsonRequest("/api/settings/smart-refresh");
export const saveSmartPolicy = (policy) => jsonRequest("/api/settings/smart-refresh", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ policy }),
});
export const resetSmartPolicy = () => jsonRequest("/api/settings/smart-refresh", { method: "DELETE" });

export function loadQuotaHistory(days = 30, options) {
  return jsonRequest(`/api/status/quota/history?days=${encodeURIComponent(days)}`, options);
}

export const loadQuotaForecast = (options) => jsonRequest("/api/status/quota/forecast", options);
export const loadSystemStatus = (options) => jsonRequest("/api/status/system", options);
export async function runDatabaseCheck() {
  try {
    return await jsonRequest("/api/status/system/database-check", { method: "POST" });
  } catch (error) {
    // A completed quick_check that finds damage deliberately returns 503.
    // Preserve that structured result so the dashboard can show it as an
    // integrity failure rather than pretending the request itself broke.
    if (error.status === 503 && error.data) return error.data;
    throw error;
  }
}
export function loadBackups(limit = 30, options) {
  return jsonRequest(`/api/status/backups?limit=${encodeURIComponent(limit)}`, options);
}
export function verifyBackup(date) {
  return jsonRequest(`/api/status/backups/${encodeURIComponent(date)}/verify`, { method: "POST" });
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  if (value < 1024) return `${value.toFixed(0)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value;
  let index = -1;
  do { scaled /= 1024; index++; } while (scaled >= 1024 && index < units.length - 1);
  return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[index]}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function quotaBarPercent(bucket = {}) {
  const units = Math.max(0, Number(bucket.units) || 0);
  const limit = Number(bucket.limit) || 0;
  return limit > 0 ? Math.min(100, (units / limit) * 100) : 0;
}

export function systemVideoCounts(database = {}) {
  const count = (value) => value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value)
    : null;
  return {
    total: count(database.totalVideoCount),
    visible: count(database.visibleVideoCount),
  };
}

export function formatBackupLastSuccess(value, formatter = String) {
  return value ? formatter(value) : "Not run since startup";
}

export function loadOperationsTab(tabId, loadedTabs, loaders = {}) {
  if (loadedTabs.has(tabId)) return Promise.resolve(false);
  const tabLoaders = {
    rules: [loaders.rules],
    quota: [loaders.quotaHistory, loaders.quotaForecast],
    system: [loaders.system],
    backups: [loaders.backups],
  }[tabId]?.filter(Boolean);
  if (!tabLoaders) return Promise.resolve(false);
  loadedTabs.add(tabId);
  return Promise.all(tabLoaders.map((loader) => loader())).then(() => true);
}

export function createLatestRequest() {
  let generation = 0;
  let controller = null;
  return async function runLatest(request, callbacks = {}) {
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    try {
      const value = await request(controller.signal);
      if (current !== generation) return { applied: false, stale: true };
      callbacks.success?.(value);
      return { applied: true, value };
    } catch (error) {
      if (current !== generation || error?.name === "AbortError") {
        return { applied: false, stale: true };
      }
      callbacks.error?.(error);
      return { applied: true, error };
    } finally {
      if (current === generation) {
        controller = null;
        callbacks.settled?.();
      }
    }
  };
}

export function policyToDraft(policy = {}) {
  return {
    noHistoryIntervalHours: String(policy.noHistoryIntervalHours ?? 24),
    newUploadCooldownHours: String(policy.newUploadCooldownHours ?? 2),
    failureRetryMinutes: (policy.failureRetryMinutes || [5, 15, 30, 60]).join(", "),
    rules: (policy.rules || []).map((rule) => ({
      id: rule.id, label: rule.label,
      minUploadAgeDays: String(rule.minUploadAgeDays),
      minRefreshIntervalHours: String(rule.minRefreshIntervalHours),
    })),
  };
}

export function draftToPolicy(draft) {
  const positive = (value, label, allowZero = false) => {
    const number = Number(value);
    if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
      throw new Error(`${label} must be ${allowZero ? "zero or greater" : "greater than zero"}`);
    }
    return number;
  };
  const retries = String(draft.failureRetryMinutes || "").split(",")
    .map((value) => value.trim()).filter(Boolean)
    .map((value, index) => positive(value, `Retry ${index + 1}`));
  if (!retries.length || retries.length > 20) throw new Error("Enter 1 to 20 retry delays");
  const ids = new Set();
  const rules = (draft.rules || []).map((rule, index) => {
    const id = String(rule.id || "").trim();
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(id)) throw new Error(`Rule ${index + 1} needs a valid id`);
    if (ids.has(id)) throw new Error(`Rule id ${id} is duplicated`);
    ids.add(id);
    return {
      id, label: String(rule.label || id).trim().slice(0, 100),
      minUploadAgeDays: positive(rule.minUploadAgeDays, `${id} upload age`, true),
      minRefreshIntervalHours: positive(rule.minRefreshIntervalHours, `${id} interval`),
    };
  });
  return {
    noHistoryIntervalHours: positive(draft.noHistoryIntervalHours, "No-history interval"),
    newUploadCooldownHours: positive(draft.newUploadCooldownHours, "Post-upload cooldown"),
    failureRetryMinutes: retries,
    rules,
  };
}

export function nextRuleId(rules = []) {
  const ids = new Set(rules.map((rule) => String(rule.id || "")));
  let suffix = 1;
  while (ids.has(`custom_rule_${suffix}`)) suffix++;
  return `custom_rule_${suffix}`;
}

export function formatReason(reason) {
  return String(reason || "unknown").replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function filterAndSortHealth(rows, filters = {}, now = Date.now()) {
  const query = String(filters.search || "").trim().toLowerCase();
  const inactivity = filters.inactivity || "all";
  const result = (rows || []).filter((row) => {
    if (query && !`${row.title} ${row.id}`.toLowerCase().includes(query)) return false;
    if (filters.status && filters.status !== "all") {
      if (filters.status === "error" && row.last_refresh_status !== "error") return false;
      if (filters.status === "ok" && !["ok", "not_modified"].includes(row.last_refresh_status)) return false;
    }
    if (filters.due === "due" && !row.smart_refresh?.due) return false;
    if (filters.due === "later" && row.smart_refresh?.due) return false;
    const upload = row.latest_upload_at ? new Date(row.latest_upload_at).getTime() : null;
    const days = upload === null ? null : Math.max(0, (now - upload) / 86400000);
    if (inactivity === "none" && upload !== null) return false;
    if (inactivity === "lt90" && !(days !== null && days < 90)) return false;
    if (inactivity === "90to364" && !(days >= 90 && days < 365)) return false;
    if (inactivity === "365plus" && !(days >= 365)) return false;
    return true;
  });
  const time = (value) => value ? new Date(value).getTime() : -Infinity;
  const sort = filters.sort || "title";
  return result.sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "status") return String(a.last_refresh_status || "").localeCompare(String(b.last_refresh_status || "")) || a.title.localeCompare(b.title);
    if (sort === "nextDue") {
      const av = a.smart_refresh?.nextDueAt ? time(a.smart_refresh.nextDueAt) : Infinity;
      const bv = b.smart_refresh?.nextDueAt ? time(b.smart_refresh.nextDueAt) : Infinity;
      return av - bv || a.title.localeCompare(b.title);
    }
    const field = sort === "upload" ? "latest_upload_at" : null;
    const av = sort === "success" ? time(a.last_success_at || a.last_refreshed_at) : time(a[field]);
    const bv = sort === "success" ? time(b.last_success_at || b.last_refreshed_at) : time(b[field]);
    return bv - av || a.title.localeCompare(b.title);
  });
}

export const MAX_BULK_CHANNELS = 500;

export function selectVisibleIds(selectedIds, visibleIds, max = MAX_BULK_CHANNELS) {
  const next = new Set(selectedIds || []);
  const visible = [...new Set(visibleIds || [])];
  if (visible.length && visible.every((id) => next.has(id))) {
    for (const id of visible) next.delete(id);
    return next;
  }
  for (const id of visible) {
    if (next.size >= max) break;
    next.add(id);
  }
  return next;
}

export function listFolderOptions(folders, depth = 0) {
  return (folders || []).flatMap((folder) => [
    { id: folder.id, name: folder.name, label: `${"— ".repeat(depth)}${folder.name}` },
    ...listFolderOptions(folder.children, depth + 1),
  ]);
}

export function getReturns(scope = {}, limit = 5000) {
  const params = scopeParams(scope);
  params.set("limit", String(limit));
  return jsonRequest(`/api/videos/returns?${params}`);
}
export const acknowledgeReturns = (videoIds) => jsonRequest("/api/videos/returns/acknowledge", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ videoIds }),
});
export async function acknowledgeAllReturnBatches(scope, {
  initial = null,
  maxBatches = 100,
  onProgress = null,
} = {}) {
  let page;
  let acknowledged = 0;
  let batches = 0;
  try {
    page = initial || await getReturns(scope, 5000);
  } catch (error) {
    return { complete: false, acknowledged, batches, initialCount: null, remaining: null, error: error.message };
  }
  const initialCount = Number(page.count) || 0;
  while (Number(page.count) > 0 && batches < maxBatches) {
    const ids = page.videoIds || [];
    if (!ids.length) {
      return { complete: false, acknowledged, batches, initialCount, remaining: page.count, error: "The server returned a count without return IDs" };
    }
    let result;
    try {
      result = await acknowledgeReturns(ids);
    } catch (error) {
      return { complete: false, acknowledged, batches, initialCount, remaining: Number(page.count) || null, error: error.message };
    }
    acknowledged += Number(result.acknowledged) || 0;
    batches++;
    try { onProgress?.({ acknowledged, batches, initialCount }); } catch {}
    try {
      page = await getReturns(scope, 5000);
    } catch (error) {
      return { complete: false, acknowledged, batches, initialCount, remaining: null, error: error.message };
    }
  }
  const remaining = Number(page.count) || 0;
  return {
    complete: remaining === 0,
    acknowledged,
    batches,
    initialCount,
    remaining,
    error: remaining ? `Stopped after the ${maxBatches}-batch safety limit` : null,
  };
}
export const resolveSubscription = (folderId, legacyId, urlOrId) => jsonRequest(
  `/api/folders/${encodeURIComponent(folderId)}/channels/${encodeURIComponent(legacyId)}/resolve`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urlOrId }) },
);
export const bulkRefresh = async (channelIds) => {
  try {
    return await jsonRequest("/api/channels/bulk/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelIds }),
    });
  } catch (error) {
    if (error.data?.summary) return { ...error.data, partial: true };
    throw error;
  }
};
export const bulkFavorite = (channelIds, favorite) => jsonRequest("/api/channels/bulk/favorite", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelIds, favorite }),
});
export const bulkDelete = (channelIds) => jsonRequest("/api/channels/bulk", {
  method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelIds }),
});
export const bulkMove = (channelIds, sourceFolderId, destinationFolderId) => jsonRequest("/api/channels/bulk/move", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ channelIds, sourceFolderId, destinationFolderId }),
});
