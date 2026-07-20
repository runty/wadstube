const express = require("express");

module.exports = function channelsRoutes(appState) {
  const router = express.Router();
  const {
    collectAllChannelIds,
    isResolvedChannel,
    removeChannelEverywhere,
    moveChannels,
    saveData,
    CHANNEL_ID_RE,
  } = require("../lib/data");
  const {
    refreshChannels,
    acquireLockWhenIdle,
    tryAcquireLock,
    releaseLock,
  } = require("../lib/refresh");
  const { rateLimit } = require("../lib/security");
  const { evaluateRefresh } = require("../lib/refresh-policy");
  const { chooseMode } = require("../lib/refresh-plan");
  const runRefresh = appState.refreshChannels || refreshChannels;
  const retryLimit = rateLimit({ windowMs: 60_000, max: 6, name: "channel refresh" });
  const bulkLimit = rateLimit({ windowMs: 60_000, max: 20, name: "bulk channel action" });

  function subscriptionDetails() {
    const details = new Map();
    function walk(folders) {
      for (const folder of folders || []) {
        for (const channel of folder.channels || []) {
          if (!isResolvedChannel(channel)) continue;
          if (!details.has(channel.id)) {
            details.set(channel.id, { title: channel.name || "Unknown", folderIds: [] });
          }
          details.get(channel.id).folderIds.push(folder.id);
        }
        walk(folder.children);
      }
    }
    walk(appState.data.folders);
    return details;
  }

  function requestedChannelIds(body, max = 500) {
    const ids = body?.channelIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > max) {
      const err = new Error(`channelIds must contain 1 to ${max} IDs`);
      err.status = 400;
      throw err;
    }
    if (ids.some((id) => typeof id !== "string" || !CHANNEL_ID_RE.test(id))) {
      const err = new Error("channelIds must contain canonical YouTube channel IDs");
      err.status = 400;
      throw err;
    }
    if (new Set(ids).size !== ids.length) {
      const err = new Error("channelIds must be unique");
      err.status = 400;
      throw err;
    }
    return ids;
  }

  function subscribed(ids) {
    const details = subscriptionDetails();
    const missing = ids.filter((id) => !details.has(id));
    if (missing.length) {
      const err = new Error(`Channel is not subscribed: ${missing[0]}`);
      err.status = 404;
      throw err;
    }
    return details;
  }

  function seedSubscribedChannels() {
    function walk(folders) {
      for (const folder of folders || []) {
        for (const channel of folder.channels || []) {
          if (!isResolvedChannel(channel)) continue;
          const meta = appState.db.getChannelMeta(channel.id);
          if (!meta || meta.title === "Unknown") {
            appState.db.upsertChannel(channel.id, channel.name || "Unknown");
          }
        }
        walk(folder.children);
      }
    }
    walk(appState.data.folders);
  }

  router.post("/bulk/refresh", retryLimit, async (req, res) => {
    let ids;
    try {
      ids = requestedChannelIds(req.body);
      subscribed(ids);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    const handle = tryAcquireLock(appState);
    if (!handle) return res.status(409).json({ error: "A manual refresh or data operation is already running" });
    try {
      const runMode = chooseMode(appState.manualMode, appState.quota, ids.length);
      const summary = await runRefresh(appState.db, ids, {
        keep: appState.maxVideos,
        mode: runMode.mode,
        requestedMode: runMode.requestedMode,
        fallbackReason: runMode.fallbackReason,
        apiKey: appState.apiKey,
        quota: appState.quota,
        policy: appState.smartPolicy,
        trigger: "manual-bulk",
        scope: `bulk:${ids.length}`,
      });
      if (summary.errors > 0) return res.status(502).json({ ok: false, summary });
      return res.json({ ok: true, summary });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    } finally {
      releaseLock(appState, handle);
    }
  });

  router.patch("/bulk/favorite", bulkLimit, (req, res) => {
    try {
      if (typeof req.body?.favorite !== "boolean") {
        return res.status(400).json({ error: "favorite boolean required" });
      }
      const ids = requestedChannelIds(req.body);
      const details = subscribed(ids);
      const titles = Object.fromEntries(ids.map((id) => [id, details.get(id).title]));
      const channels = appState.db.setChannelsFavorite(ids, req.body.favorite, titles)
        .map((channel) => ({ ...channel, favorite: !!channel.favorite }));
      return res.json({ ok: true, channels });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.delete("/bulk", bulkLimit, async (req, res) => {
    let ids;
    try {
      ids = requestedChannelIds(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const handle = await acquireLockWhenIdle(appState);
    try {
      subscribed(ids);
      const originalData = structuredClone(appState.data);
      const nextData = structuredClone(appState.data);
      let removedMemberships = 0;
      for (const id of ids) removedMemberships += removeChannelEverywhere(nextData, id);
      try {
        saveData(appState.dataDir, nextData);
      } catch (err) {
        err.httpStatus = 500;
        throw err;
      }
      appState.data = nextData;
      try {
        appState.db.removeChannels(ids);
      } catch (dbError) {
        try {
          saveData(appState.dataDir, originalData);
          appState.data = originalData;
        } catch (recoveryError) {
          // The replacement tree remains the last successful durable save,
          // so memory must continue to describe it for explicit recovery.
          appState.data = nextData;
          const err = new Error(
            `Channel deletion database cleanup failed (${dbError.message}); ` +
              `subscription recovery also failed (${recoveryError.message}). ` +
              "The saved subscription removal remains active and requires recovery.",
          );
          err.httpStatus = 500;
          throw err;
        }
        const err = new Error(
          `Channel deletion database cleanup failed; subscription changes were rolled back: ${dbError.message}`,
        );
        err.httpStatus = 500;
        throw err;
      }
      return res.json({ ok: true, removedChannels: ids.length, removedMemberships });
    } catch (err) {
      return res.status(err.httpStatus || err.status || 400).json({ error: err.message });
    } finally {
      releaseLock(appState, handle);
    }
  });

  router.post("/bulk/move", bulkLimit, async (req, res) => {
    let ids;
    try {
      ids = requestedChannelIds(req.body);
      if (typeof req.body?.sourceFolderId !== "string" ||
          typeof req.body?.destinationFolderId !== "string") {
        return res.status(400).json({ error: "sourceFolderId and destinationFolderId are required" });
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const handle = await acquireLockWhenIdle(appState);
    try {
      const nextData = structuredClone(appState.data);
      const result = moveChannels(
        nextData,
        req.body.sourceFolderId,
        req.body.destinationFolderId,
        ids,
      );
      try {
        saveData(appState.dataDir, nextData);
      } catch (err) {
        err.httpStatus = 500;
        throw err;
      }
      appState.data = nextData;
      return res.json({
        ok: true,
        moved: result.moved.length,
        deduplicated: result.deduplicated.length,
        movedChannelIds: result.moved,
        deduplicatedChannelIds: result.deduplicated,
      });
    } catch (err) {
      return res.status(err.httpStatus || err.status || 400).json({ error: err.message });
    } finally {
      releaseLock(appState, handle);
    }
  });

  router.get("/", (req, res) => {
    seedSubscribedChannels();
    const details = subscriptionDetails();
    const status = ["all", "stale", "error"].includes(req.query.status)
      ? req.query.status
      : "all";
    const staleHours = Math.min(Math.max(Number(req.query.stale_hours) || 24, 1), 8760);
    const rows = appState.db.listChannelHealth({
      status,
      favorite: req.query.favorite === "1" ? true : undefined,
      staleBefore: new Date(Date.now() - staleHours * 3600_000).toISOString(),
    }).filter((row) => CHANNEL_ID_RE.test(row.id)).map((row) => ({
      ...row,
      folderIds: details.get(row.id)?.folderIds || [],
      smart_refresh: evaluateRefresh(row, {
        policy: appState.smartPolicy,
        baseIntervalMinutes: appState.refreshIntervalMinutes,
      }),
    }));
    res.json(rows);
  });

  router.patch("/:channelId", (req, res) => {
    try {
      if (typeof req.body?.favorite !== "boolean") {
        return res.status(400).json({ error: "favorite boolean required" });
      }
      let subscription = null;
      function find(folders) {
        for (const folder of folders || []) {
          subscription = folder.channels?.find((channel) => channel.id === req.params.channelId) || null;
          if (subscription || find(folder.children)) return true;
        }
        return false;
      }
      find(appState.data.folders);
      if (!subscription) return res.status(404).json({ error: "Channel is not subscribed" });
      if (!isResolvedChannel(subscription)) {
        return res.status(409).json({ error: "Unresolved subscriptions cannot be favorited until replaced with a channel ID" });
      }
      if (!appState.db.getChannelMeta(req.params.channelId)) {
        appState.db.upsertChannel(subscription.id, subscription.name);
      }
      const channel = appState.db.setChannelFavorite(req.params.channelId, req.body.favorite);
      res.json({ ok: true, channel: { ...channel, favorite: !!channel.favorite } });
    } catch (err) {
      res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  });

  router.delete("/:channelId", async (req, res) => {
    if (!CHANNEL_ID_RE.test(req.params.channelId)) {
      return res.status(400).json({ error: "Invalid YouTube channel ID" });
    }
    const handle = await acquireLockWhenIdle(appState);
    try {
      const removedMemberships = removeChannelEverywhere(appState.data, req.params.channelId);
      if (!removedMemberships) {
        return res.status(404).json({ error: "Channel is not subscribed" });
      }
      saveData(appState.dataDir, appState.data);
      appState.db.removeChannel(req.params.channelId);
      res.json({ ok: true, removedMemberships });
    } catch (err) {
      res.status(400).json({ error: err.message });
    } finally {
      releaseLock(appState, handle);
    }
  });

  router.post("/:channelId/refresh", retryLimit, async (req, res) => {
    const subscribed = appState.data.folders.some((folder) =>
      collectAllChannelIds(folder).includes(req.params.channelId),
    );
    if (!subscribed) return res.status(404).json({ error: "Channel is not subscribed" });
    const handle = tryAcquireLock(appState);
    if (!handle) return res.status(409).json({ error: "A manual refresh or data operation is already running" });
    try {
      const summary = await runRefresh(appState.db, [req.params.channelId], {
        keep: appState.maxVideos,
        mode: appState.manualMode,
        apiKey: appState.apiKey,
        quota: appState.quota,
        policy: appState.smartPolicy,
        trigger: "manual-retry",
        scope: req.params.channelId,
      });
      if (summary.errors > 0) {
        const message = appState.db.getChannelMeta(req.params.channelId)?.last_error ||
          "Channel refresh failed";
        return res.status(502).json({ ok: false, error: message, summary });
      }
      res.json({ ok: true, summary });
    } catch (err) {
      res.status(502).json({ error: err.message });
    } finally {
      releaseLock(appState, handle);
    }
  });

  return router;
};
