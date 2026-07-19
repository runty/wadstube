const express = require("express");

module.exports = function channelsRoutes(appState) {
  const router = express.Router();
  const {
    collectAllChannelIds,
    isResolvedChannel,
    removeChannelEverywhere,
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
  const runRefresh = appState.refreshChannels || refreshChannels;
  const retryLimit = rateLimit({ windowMs: 60_000, max: 6, name: "channel refresh" });

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

  router.get("/", (req, res) => {
    seedSubscribedChannels();
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
