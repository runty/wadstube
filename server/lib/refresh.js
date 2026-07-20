const { fetchChannelFeed } = require("./rss");
const { checkIsShort, fetchChannelViaApi } = require("./youtube");
const { strongestMatchingRule } = require("./refresh-policy");
const { createRunMetrics } = require("./quota");

// RSS shares a per-IP rate limit at YouTube — higher concurrency trips it.
// The API endpoint is quota-bound, not rate-limited per-second, so we can
// run it much wider.
const CHANNEL_CONCURRENCY_RSS = 5;
const CHANNEL_CONCURRENCY_API = 20;
// Shorts HEAD checks hit a different endpoint with its own (generous)
// limits. The old pre-DB code ran 10 per-channel × 20 channels = ~200 in
// flight and was fine; we match that ceiling with a shared pool.
const SHORTS_CONCURRENCY = 200;

// Only authoritative, structured YouTube quota/rate-limit reasons may switch
// a refresh to RSS. Authentication, permissions, not-found, and availability
// failures remain visible errors instead of being silently masked.
const RSS_FALLBACK_ERROR_CODES = new Set([
  "quotabudgetexceeded",
  "quotaexceeded",
  "dailylimitexceeded",
  "ratelimitexceeded",
  "userratelimitexceeded",
]);

function isRssFallbackErrorCode(code) {
  return typeof code === "string" && RSS_FALLBACK_ERROR_CODES.has(code.toLowerCase());
}

let _pLimit;
async function getPLimit() {
  if (!_pLimit) _pLimit = (await import("p-limit")).default;
  return _pLimit;
}

async function classifyPendingVideos(db, videos, limit, {
  metrics = null,
  highlightRule = null,
  allowHighlight = false,
  latestKnownUploadAt = null,
} = {}) {
  const pending = [];
  const freshIds = new Set();
  const statusById = new Map();
  for (const video of videos) {
    const meta = db.getVideoClassificationMeta?.(video.video_id) ||
      (db.getVideoClassification(video.video_id) ? { short_status: db.getVideoClassification(video.video_id) } : null);
    const status = meta?.short_status || null;
    statusById.set(video.video_id, status);
    if (status === null) {
      freshIds.add(video.video_id);
      pending.push(video);
    } else if (status === "unknown" && (db.isVideoClassificationDue?.(video.video_id) ?? true)) {
      pending.push(video);
    }
  }
  if (!pending.length) {
    return {
      newVisible: 0,
      newShorts: 0,
      unknown: 0,
      byId: new Map(),
      statusById,
      probed: 0,
    };
  }
  const classified = await Promise.all(
    pending.map((v) =>
      limit(async () => ({
        ...v,
        short_status: await checkIsShort(v.video_id, metrics),
      })),
    ),
  );
  let newVisible = 0;
  let newShorts = 0;
  let unknown = 0;
  for (const video of classified) {
    if (
      allowHighlight && highlightRule && freshIds.has(video.video_id) &&
      video.short_status === "long" &&
      (!latestKnownUploadAt || video.published > latestKnownUploadAt)
    ) {
      video.highlight_reason = highlightRule.id;
    } else if (
      allowHighlight && highlightRule && freshIds.has(video.video_id) &&
      video.short_status === "unknown" &&
      (!latestKnownUploadAt || video.published > latestKnownUploadAt)
    ) {
      video.pending_highlight_reason = highlightRule.id;
    }
    if (video.short_status === "unknown") unknown++;
    if (!freshIds.has(video.video_id)) continue;
    if (video.short_status === "short") newShorts++;
    else newVisible++;
  }
  return {
    newVisible,
    newShorts,
    unknown,
    byId: new Map(classified.map((v) => [v.video_id, v])),
    statusById,
    probed: classified.length,
  };
}

// Refresh the given channels via RSS, upsert results into the DB, prune to N
// per channel, and classify any newly-seen videos as shorts. Calls onEvent
// with per-channel lifecycle messages so callers can stream progress:
//   { type:"start", channelId, channelTitle }
//   { type:"done",  channelId, channelTitle, status, newVideos, error? }
// Returns visible new videos separately from filtered Shorts and retryable
// unknown classifications.
async function refreshChannels(db, channelIds, opts = {}, onEvent = null) {
  const {
    keep = 50, mode = "rss", apiKey = null, quota = null,
    trigger = "manual", scope = "all", policy = null,
    skipped = 0, requestedMode = mode, fallbackReason = null,
  } = opts;
  const pendingShortLimit = opts.pendingShortLimit ?? 20;
  if (mode === "api" && !apiKey) {
    throw new Error("REFRESH_MODE=api requires YOUTUBE_API_KEY");
  }
  const ids = [...new Set(channelIds)];
  const metrics = opts.metrics || createRunMetrics({
    trigger,
    mode: requestedMode,
    requestedMode,
    effectiveMode: mode,
    fallbackReason,
    scope,
    requestedChannels: ids.length + skipped,
  });
  metrics.requested_mode ||= requestedMode;
  metrics.effective_mode ||= mode;
  metrics.rss_fallbacks ||= 0;
  metrics.fallback_reason ||= fallbackReason;
  const runId = db.startRefreshRun?.(metrics) || null;
  const finishRun = (summary, status = "complete", error = null) => {
    if (metrics.requested_mode === "api") {
      if (mode === "rss") {
        metrics.effective_mode = "rss";
      } else if (metrics.rss_fallbacks > 0) {
        const localBudgetOnly = String(metrics.fallback_reason || "").toLowerCase() ===
          "quotabudgetexceeded";
        metrics.effective_mode = metrics.api_calls > 0 ||
          !localBudgetOnly
          ? "api+rss"
          : "rss";
      } else {
        metrics.effective_mode = "api";
      }
    } else {
      metrics.effective_mode = "rss";
    }
    let quotaStatus = null;
    try { quotaStatus = quota?.status() || null; } catch {}
    const dailyRemaining = quotaStatus?.buckets?.general?.remaining ?? null;
    const finalizedSummary = {
      ...summary,
      skipped,
      run_id: runId,
      api_calls: metrics.api_calls,
      api_units: metrics.api_units,
      api_by_endpoint: metrics.api_by_endpoint,
      rss_requests: metrics.rss_requests,
      requested_mode: metrics.requested_mode,
      effective_mode: metrics.effective_mode,
      rss_fallbacks: metrics.rss_fallbacks,
      fallback_reason: metrics.fallback_reason,
      shorts_probes: metrics.shorts_probes,
      daily_remaining: dailyRemaining,
      quota: quotaStatus,
    };
    if (runId) {
      db.finishRefreshRun?.(
        runId,
        finalizedSummary,
        metrics,
        { status, error, dailyRemaining },
      );
    }
    return finalizedSummary;
  };
  if (!ids.length) {
    return finishRun({
      checked: 0,
      updated: 0,
      new_videos: 0,
      new_shorts: 0,
      classification_unknown: 0,
      errors: 0,
    });
  }

  const pLimit = await getPLimit();
  const channelConcurrency =
    mode === "api" ? CHANNEL_CONCURRENCY_API : CHANNEL_CONCURRENCY_RSS;
  const channelLimit = pLimit(channelConcurrency);
  const rssLimit = pLimit(CHANNEL_CONCURRENCY_RSS);
  const shortLimit = pLimit(SHORTS_CONCURRENCY);
  const apiFallback = {
    tripped: requestedMode === "api" && mode === "rss" && !!fallbackReason,
  };

  function fetchRss(id, cached, { fallback = false } = {}) {
    // This is a channel-routing count, not a successful-response count.
    // Record the redirect before awaiting RSS so a parser/fetch exception
    // still produces an accurate run report; rss_requests remains the
    // lower-level network-attempt counter in rss.js.
    if (fallback) metrics.rss_fallbacks++;
    return rssLimit(() => fetchChannelFeed(id, cached, { metrics }));
  }

  let updated = 0;
  let newVideoCount = 0;
  let newShortCount = 0;
  let classificationUnknown = 0;
  let errors = 0;
  let completed = 0;

  // Progress reporting is ancillary. A disconnected client or a buggy
  // callback must never turn a successful refresh into a worker failure.
  function emit(event) {
    try { onEvent?.(event); }
    catch (err) { console.warn(`[refresh] progress callback failed: ${err.message}`); }
  }

  async function processChannel(id) {
    // Cached metadata for conditional GET + "start" event title.
    let meta = db.getChannelMeta(id);
    if (!meta) {
      db.upsertChannel(id, "Unknown");
      meta = { id, title: "Unknown", last_etag: null, last_modified: null };
    }
    const wasPreviouslyRefreshed = !!meta.last_refreshed_at;
    const highlightRule = policy
      ? strongestMatchingRule(meta.latest_upload_at, new Date(), policy)
      : null;
    emit({ type: "start", channelId: id, channelTitle: meta.title });

    const now = new Date().toISOString();
    db.recordChannelRefreshAttempt?.(id, now);
    const cached = {
      last_etag: meta.last_etag,
      last_modified: meta.last_modified,
    };
    let feed;
    if (mode === "api") {
      if (apiFallback.tripped) {
        feed = await fetchRss(id, cached, { fallback: true });
      } else {
        feed = await fetchChannelViaApi(apiKey, id, { quota, metrics });
        if (feed.status === "error" && isRssFallbackErrorCode(feed.errorCode)) {
          apiFallback.tripped = true;
          metrics.fallback_reason ||= feed.errorCode;
          feed = await fetchRss(id, cached, { fallback: true });
        }
      }
    } else {
      feed = await fetchRss(id, cached, { fallback: requestedMode === "api" });
    }

    if (feed.status === "error") {
      errors++;
      db.recordChannelRefreshFailure?.(id, feed.error || "Refresh failed", now);
      emit({
          type: "done",
          channelId: id,
          channelTitle: meta.title,
          status: "error",
          newVideos: 0,
          newShorts: 0,
          error: feed.error,
        });
      return;
    }

    if (feed.status === "not_modified") {
      db.updateChannelMeta(id, {
        last_checked_at: now,
        last_etag: meta.last_etag,
        last_modified: meta.last_modified,
      });
      db.updateChannelHealth?.(id, {
        status: "not_modified",
        error: null,
        checkedAt: now,
        successAt: now,
      });
      db.recordChannelRefreshSuccess?.(id, now, "not_modified", false);
      emit({
          type: "done",
          channelId: id,
          channelTitle: meta.title,
          status: "not_modified",
          newVideos: 0,
          newShorts: 0,
        });
      return;
    }

    // ok
    const title = feed.channelTitle || meta.title;
    if (feed.channelTitle) db.upsertChannel(id, feed.channelTitle);

    const classified = await classifyPendingVideos(
      db,
      feed.videos,
      shortLimit,
      {
        metrics,
        highlightRule,
        allowHighlight: wasPreviouslyRefreshed,
        latestKnownUploadAt: meta.latest_upload_at,
      },
    );
    newVideoCount += classified.newVisible;
    newShortCount += classified.newShorts;
    classificationUnknown += classified.unknown;

    const toUpsert = feed.videos.map(
      (v) => classified.byId.get(v.video_id) || {
        ...v,
        short_status: classified.statusById.get(v.video_id) || "unknown",
      },
    );
    db.upsertVideos(toUpsert);
    for (const video of classified.byId.values()) {
      db.recordVideoClassification?.(video.video_id, video.short_status, now);
    }
    const latestUpload = feed.videos.reduce(
      (latest, video) => !latest || video.published > latest ? video.published : latest,
      null,
    );
    db.setLatestUploadAt?.(id, latestUpload);
    db.pruneChannel(id, keep);
    db.updateChannelMeta(id, {
      last_checked_at: now,
      last_etag: feed.etag,
      last_modified: feed.lastModified,
    });
    db.updateChannelHealth?.(id, {
      status: "ok",
      error: null,
      checkedAt: now,
      successAt: now,
    });
    const hadUpload = classified.newVisible + classified.newShorts > 0;
    db.recordChannelRefreshSuccess?.(id, now, "ok", hadUpload);
    updated++;

    emit({
        type: "done",
        channelId: id,
        channelTitle: title,
        status: "ok",
        newVideos: classified.newVisible,
        newShorts: classified.newShorts,
        classificationUnknown: classified.unknown,
      });
  }

  async function safeProcessChannel(id) {
    try {
      await processChannel(id);
    } catch (err) {
      errors++;
      const at = new Date().toISOString();
      try { db.recordChannelRefreshFailure?.(id, err.message, at); }
      catch (recordErr) {
        console.error(`[refresh] could not record failure for ${id}: ${recordErr.message}`);
      }
      let title = id;
      try { title = db.getChannelMeta(id)?.title || id; } catch {}
      emit({
        type: "done", channelId: id, channelTitle: title, status: "error",
        newVideos: 0, newShorts: 0, error: err.message,
      });
    } finally {
      completed++;
    }
  }

  try {
    // Always wait for every sibling before finalizing the run. This remains
    // defensive even though safeProcessChannel is designed never to reject.
    const workerResults = await Promise.allSettled(
      ids.map((id) => channelLimit(() => safeProcessChannel(id))),
    );
    for (const [index, result] of workerResults.entries()) {
      if (result.status !== "rejected") continue;
      errors++;
      const id = ids[index];
      const message = result.reason?.message || String(result.reason);
      try { db.recordChannelRefreshFailure?.(id, message, new Date().toISOString()); } catch {}
      emit({
        type: "done", channelId: id, channelTitle: id, status: "error",
        newVideos: 0, newShorts: 0, error: message,
      });
    }

    // Retry durable unknown classifications independently of the current RSS
    // window. Selection is DB-backed and exponentially paced per video.
    const pending = db.listPendingShorts?.(pendingShortLimit) || [];
    let pendingReclassified = 0;
    const pendingResults = await Promise.allSettled(pending.map((video) => shortLimit(async () => {
      const status = await checkIsShort(video.video_id, metrics);
      db.recordVideoClassification?.(video.video_id, status);
      if (status !== "unknown") pendingReclassified++;
    })));
    errors += pendingResults.filter((result) => result.status === "rejected").length;
    const pendingUnknownTotal = db.countUnknownShorts?.() || 0;
    const summary = {
      checked: completed,
      updated,
      new_videos: newVideoCount,
      new_shorts: newShortCount,
      classification_unknown: classificationUnknown,
      errors,
      pending_unknown_total: pendingUnknownTotal,
      pending_unknown_due: pending.length,
      pending_reclassified: pendingReclassified,
    };
    return finishRun(summary);
  } catch (err) {
    const partial = {
      checked: completed,
      updated,
      new_videos: newVideoCount,
      new_shorts: newShortCount,
      classification_unknown: classificationUnknown,
      errors: errors + 1,
    };
    finishRun(partial, "error", err.message);
    throw err;
  }
}

// Atomically try to take the refresh lock. Returns null if someone else
// holds it, otherwise returns a handle that can be passed to releaseLock.
// Both operations are synchronous so the check + set can't be split by
// Node's event loop.
function tryAcquireLock(appState) {
  if (appState.refreshLock) return null;
  let release;
  const lock = new Promise((r) => { release = r; });
  appState.refreshLock = lock;
  return { lock, release };
}

function releaseLock(appState, handle) {
  if (!handle) return;
  handle.release();
  // Only clear if we're still the current holder; a late release from a
  // superseded run must not wipe out a lock owned by a newer run.
  if (appState.refreshLock === handle.lock) appState.refreshLock = null;
}

// Wait for the current owner, then atomically become the next owner before
// another manual refresh can start. Destructive data operations
// use this so a completed refresh cannot reinsert rows after their final
// orphan purge.
async function acquireLockWhenIdle(appState) {
  while (true) {
    const handle = tryAcquireLock(appState);
    if (handle) return handle;
    const current = appState.refreshLock;
    if (current) await current;
  }
}

// Wait for any in-flight refresh to finish (regardless of who holds the
// lock). Used by the nightly backup so VACUUM INTO doesn't race writes.
async function waitForRefreshIdle(appState) {
  while (appState.refreshLock) {
    await appState.refreshLock;
  }
}

module.exports = {
  refreshChannels,
  isRssFallbackErrorCode,
  tryAcquireLock,
  acquireLockWhenIdle,
  releaseLock,
  waitForRefreshIdle,
};
