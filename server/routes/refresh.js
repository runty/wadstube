const express = require("express");

module.exports = function (appState) {
  const router = express.Router();
  const { isResolvedChannel, syncChannelNames, saveData, resolveFolderRouteId } =
    require("../lib/data");
  const {
    refreshChannels,
    tryAcquireLock,
    releaseLock,
  } = require("../lib/refresh");
  const { buildRefreshPlan, serializeRefreshPlan } = require("../lib/refresh-plan");
  const performRefresh = appState.refreshChannels || refreshChannels;

  function syncNamesFromDb() {
    const names = appState.db.getChannelNames();
    const updated = syncChannelNames(appState.data, names);
    if (updated > 0) {
      saveData(appState.dataDir, appState.data);
      console.log(`Updated ${updated} channel name(s) in tube.json`);
    }
  }

  async function runRefresh(channelIds, onEvent, scope = "all", skipped = 0, runMode = {}) {
    const summary = await performRefresh(
      appState.db,
      channelIds,
      {
        keep: appState.maxVideos,
        mode: runMode.effective || appState.manualMode,
        requestedMode: runMode.requested || appState.manualMode,
        fallbackReason: runMode.fallbackReason || null,
        apiKey: appState.apiKey,
        quota: appState.quota,
        policy: appState.smartPolicy,
        trigger: "manual",
        scope,
        skipped,
      },
      onEvent,
    );
    syncNamesFromDb();
    return summary;
  }

  // Write a JSON line to an open response, returning false if the client
  // has already disconnected so the caller can stop emitting.
  function writeEvent(res, obj) {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  function startStream(res, total) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no"); // hint for reverse proxies
    res.flushHeaders?.();
    writeEvent(res, { type: "init", total });
  }

  async function streamRefresh(req, res, channelIds, meta = {}) {
    const total = channelIds.length;
    startStream(res, total);
    let alive = true;
    req.on("close", () => { alive = false; });

    const onEvent = (ev) => {
      if (!alive) return;
      writeEvent(res, ev);
    };

    try {
      const summary = await runRefresh(
        channelIds,
        onEvent,
        meta.folder || meta.label || "all",
        meta.skipped || 0,
        meta.runMode,
      );
      console.log(
        `Refresh ${meta.label || "all"} done: ${summary.updated} with updates, ` +
          `${summary.new_videos} new videos, ${summary.errors} errors`,
      );
      const stats = appState.db.getStats();
      // Client reloads the feed via the paginated /api/videos endpoint
      // after the stream ends, so we don't ship the (potentially huge)
      // video list back here anymore.
      writeEvent(res, {
        type: "summary",
        checked: summary.checked,
        refreshed: summary.updated,
        skipped: summary.skipped,
        new_videos: summary.new_videos,
        new_shorts: summary.new_shorts,
        classification_unknown: summary.classification_unknown,
        errors: summary.errors,
        run_id: summary.run_id,
        api_calls: summary.api_calls,
        api_units: summary.api_units,
        api_by_endpoint: summary.api_by_endpoint,
        rss_requests: summary.rss_requests,
        requested_mode: summary.requested_mode,
        effective_mode: summary.effective_mode,
        rss_fallbacks: summary.rss_fallbacks,
        fallback_reason: summary.fallback_reason,
        shorts_probes: summary.shorts_probes,
        pending_unknown_total: summary.pending_unknown_total,
        pending_unknown_due: summary.pending_unknown_due,
        pending_reclassified: summary.pending_reclassified,
        daily_remaining: summary.daily_remaining,
        daily_used: summary.quota?.buckets?.general?.used ?? null,
        total_channels: stats.channelCount,
        total_videos: stats.videoCount,
      });
    } catch (err) {
      console.error(`Refresh ${meta.label || "all"} error:`, err);
      writeEvent(res, { type: "error", error: err.message });
    } finally {
      res.end();
    }
  }

  function tryAcquireOrReject(res) {
    const handle = tryAcquireLock(appState);
    if (!handle) {
      res.status(409).json({
        error: "A manual refresh or data operation is already running. Try again when it finishes.",
      });
    }
    return handle;
  }

  function seedSelectedChannelTitles(channelIds) {
    const names = new Map();
    function walk(folders) {
      for (const folder of folders || []) {
        for (const channel of folder.channels || []) {
          if (isResolvedChannel(channel) && !names.has(channel.id)) {
            names.set(channel.id, channel.name || "Unknown");
          }
        }
        walk(folder.children);
      }
    }
    walk(appState.data.folders);
    for (const id of new Set(channelIds)) {
      const meta = appState.db.getChannelMeta(id);
      if (!meta || meta.title === "Unknown") {
        appState.db.upsertChannel(id, names.get(id) || "Unknown");
      }
    }
  }

  function folderId(identifier, res) {
    const resolved = resolveFolderRouteId(appState.data, identifier);
    if (resolved.legacyName) {
      res.setHeader("Deprecation", "true");
      res.setHeader("Warning", '299 - "Folder-name routes are deprecated; use immutable folder IDs"');
    }
    return resolved.id;
  }

  // Preview is deliberately read-only. POST always builds a fresh plan after
  // taking the lock rather than trusting this response as an execution token.
  router.get("/preview", (_req, res) => {
    try {
      res.json(serializeRefreshPlan(buildRefreshPlan(appState)));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/preview/:folder", (req, res) => {
    try {
      res.json(serializeRefreshPlan(buildRefreshPlan(appState, {
        folderId: folderId(req.params.folder, res),
      })));
    } catch (err) {
      res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  });

  // Refresh all
  router.post("/", async (req, res) => {
    const handle = tryAcquireOrReject(res);
    if (!handle) return;
    try {
      const plan = buildRefreshPlan(appState);
      seedSelectedChannelTitles(plan.channels.plans.map((channel) => channel.channel_id));
      const skipped = plan.memberships.unresolved + plan.channels.skipped;
      console.log(`Refreshing all: ${plan.channels.due} due, ${skipped} skipped`);
      await streamRefresh(req, res, plan.channels.dueIds, {
        label: "all",
        skipped,
        runMode: plan.mode,
      });
    } finally {
      releaseLock(appState, handle);
    }
  });

  // Refresh specific folder
  router.post("/:folder", async (req, res) => {
    let folder;
    try { folder = folderId(req.params.folder, res); }
    catch (err) { return res.status(404).json({ error: err.message }); }
    const handle = tryAcquireOrReject(res);
    if (!handle) return;
    try {
      const plan = buildRefreshPlan(appState, { folderId: folder });
      seedSelectedChannelTitles(plan.channels.plans.map((channel) => channel.channel_id));
      const skipped = plan.memberships.unresolved + plan.channels.skipped;
      console.log(`Refreshing folder "${folder}": ${plan.channels.due} due, ${skipped} skipped`);
      await streamRefresh(req, res, plan.channels.dueIds, {
        label: `"${folder}"`,
        folder,
        skipped,
        runMode: plan.mode,
      });
    } finally {
      releaseLock(appState, handle);
    }
  });

  return router;
};
