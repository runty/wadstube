const express = require("express");

module.exports = function (appState) {
  const router = express.Router();
  const { getChannelsForFolder, collectAllChannelIds, collectAllChannels, findFolder,
    isResolvedChannel, syncChannelNames, saveData, resolveFolderRouteId } =
    require("../lib/data");
  const { refreshChannels, tryAcquireLock, releaseLock } = require("../lib/refresh");
  const { evaluateRefresh } = require("../lib/refresh-policy");

  function syncNamesFromDb() {
    const names = appState.db.getChannelNames();
    const updated = syncChannelNames(appState.data, names);
    if (updated > 0) {
      saveData(appState.dataDir, appState.data);
      console.log(`Updated ${updated} channel name(s) in tube.json`);
    }
  }

  async function runRefresh(channelIds, onEvent, scope = "all", skipped = 0) {
    const summary = await refreshChannels(
      appState.db,
      channelIds,
      {
        keep: appState.maxVideos,
        mode: appState.manualMode,
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

  function guardApiBudget(res, count) {
    if (appState.manualMode !== "api" || !appState.quota) return true;
    try {
      appState.quota.assertCanSpend("general", count);
      return true;
    } catch (err) {
      res.status(429).json({ error: err.message, quota: appState.quota.status() });
      return false;
    }
  }

  // Refresh is always initiated by the user. Active channels are eligible on
  // every click; inactivity/no-history/failure rules only suppress channels
  // whose stored minimum interval has not elapsed yet.
  function selectDueChannels(channelIds) {
    const unique = [...new Set(channelIds)];
    const metadata = new Map(
      appState.db.listChannelRefreshMeta(unique).map((row) => [row.id, row]),
    );
    const due = [];
    let skipped = 0;
    for (const id of unique) {
      const eligibility = evaluateRefresh(metadata.get(id) || {}, {
        policy: appState.smartPolicy,
        baseIntervalMinutes: 0,
      });
      if (eligibility.due) due.push(id);
      else skipped++;
    }
    return { due, skipped };
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

  // Refresh all
  router.post("/", async (req, res) => {
    const handle = tryAcquireOrReject(res);
    if (!handle) return;
    try {
      const allChannels = [];
      let skipped = 0;
      for (const folder of appState.data.folders) {
        allChannels.push(...collectAllChannelIds(folder));
        skipped += collectAllChannels(folder).filter((channel) => !isResolvedChannel(channel)).length;
      }
      seedSelectedChannelTitles(allChannels);
      const selected = selectDueChannels(allChannels);
      skipped += selected.skipped;
      if (!guardApiBudget(res, selected.due.length)) return;
      console.log(`Refreshing all: ${selected.due.length} due, ${skipped} skipped`);
      await streamRefresh(req, res, selected.due, { label: "all", skipped });
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
      const channelIds = getChannelsForFolder(appState.data, folder);
      const allMemberships = collectAllChannels(findFolder(appState.data.folders, folder));
      if (allMemberships.length === 0) {
        res.status(404).json({ error: `Folder "${folder}" not found` });
        return;
      }
      const skipped = allMemberships.filter((channel) => !isResolvedChannel(channel)).length;
      seedSelectedChannelTitles(channelIds);
      const selected = selectDueChannels(channelIds);
      const totalSkipped = skipped + selected.skipped;
      if (!guardApiBudget(res, selected.due.length)) return;
      console.log(`Refreshing folder "${folder}": ${selected.due.length} due, ${totalSkipped} skipped`);
      await streamRefresh(req, res, selected.due, {
        label: `"${folder}"`,
        folder,
        channelIdsForFolder: channelIds,
        skipped: totalSkipped,
      });
    } finally {
      releaseLock(appState, handle);
    }
  });

  return router;
};
