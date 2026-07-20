const express = require("express");

const DEFAULT_LIMIT = 200;

module.exports = function (appState) {
  const router = express.Router();
  const { getChannelsForFolder, resolveFolderRouteId } = require("../lib/data");
  const { rateLimit } = require("../lib/security");
  const returnActionLimit = rateLimit({
    windowMs: 60_000,
    max: 30,
    name: "return acknowledgement",
  });

  function folderId(identifier, res) {
    const resolved = resolveFolderRouteId(appState.data, identifier);
    if (resolved.legacyName) {
      res.setHeader("Deprecation", "true");
      res.setHeader("Warning", '299 - "Folder-name routes are deprecated; use immutable folder IDs"');
    }
    return resolved.id;
  }

  const Q_MAX_LEN = 200;

  router.get("/", (req, res) => {
    const folder = req.query.folder;
    const channelId = req.query.channel || undefined;
    let q = req.query.q || undefined;
    if (typeof q === "string" && q.length > Q_MAX_LEN) {
      q = q.slice(0, Q_MAX_LEN);
    }
    const before = req.query.before || undefined;
    const beforeId = req.query.before_id || undefined;
    const beforeFavorite = req.query.before_favorite === "1" ? 1 : 0;
    const beforeReturning = req.query.before_returning === "1" ? 1 : 0;
    const view = ["all", "unread", "starred", "hidden", "returns"].includes(req.query.view)
      ? req.query.view
      : "all";
    const favorites = req.query.favorites === "1";
    const sort = ["newest", "oldest", "favorite", "returning"].includes(req.query.sort)
      ? req.query.sort
      : "newest";
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
      500,
    );

    // Resolve folder → channel-id set. "__all__" (or missing) means no
    // folder filter; the DB still restricts to non-shorts.
    let channelIds;
    if (folder && folder !== "__all__") {
      let resolvedFolder;
      try { resolvedFolder = folderId(folder, res); }
      catch (err) { return res.status(404).json({ error: err.message }); }
      channelIds = getChannelsForFolder(appState.data, resolvedFolder);
      if (channelIds.length === 0) {
        return res.json({ videos: [], hasMore: false });
      }
    }

    // Ask for one extra row so we can signal hasMore without a COUNT(*).
    const rows = appState.db.queryVideos({
      channelIds,
      channelId,
      q,
      before,
      beforeId,
      beforeFavorite,
      beforeReturning,
      view,
      favorites,
      sort,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    if (hasMore) rows.length = limit;
    const ruleLabels = new Map([
      // Keep historical highlights readable after policy thresholds change.
      ["return_after_6_months", "Returned after 6 months"],
      ...(appState.smartPolicy?.rules || []).map((rule) => [rule.id, rule.label]),
    ]);
    for (const row of rows) {
      row.highlight_label = row.highlight_reason
        ? ruleLabels.get(row.highlight_reason) || row.highlight_reason
        : null;
    }

    res.json({ videos: rows, hasMore });
  });

  router.get("/counts", (_req, res) => {
    res.json({ unreadByChannel: appState.db.getUnreadCounts() });
  });

  router.get("/returns", (req, res) => {
    let options;
    try {
      let channelIds;
      if (req.query.folder && req.query.folder !== "__all__") {
        channelIds = getChannelsForFolder(appState.data, folderId(req.query.folder, res));
        if (!channelIds.length) return res.json({ count: 0, videoIds: [] });
      }
      const q = typeof req.query.q === "string"
        ? req.query.q.slice(0, Q_MAX_LEN)
        : undefined;
      const sort = ["newest", "oldest", "favorite", "returning"].includes(req.query.sort)
        ? req.query.sort
        : "newest";
      let limit = 500;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1) {
          return res.status(400).json({ error: "limit must be a positive integer" });
        }
        limit = Math.min(limit, 5000);
      }
      options = {
        channelIds,
        channelId: req.query.channel || undefined,
        q,
        favorites: req.query.favorites === "1",
        sort,
        limit,
      };
    } catch (err) {
      return res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
    }
    try {
      const result = appState.db.listUnacknowledgedReturns(options);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/returns/acknowledge", returnActionLimit, (req, res) => {
    let videoIds;
    try {
      videoIds = req.body?.videoIds;
      if (!Array.isArray(videoIds) || videoIds.length < 1 || videoIds.length > 5000) {
        return res.status(400).json({ error: "videoIds must contain 1 to 5000 IDs" });
      }
      if (videoIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 128)) {
        return res.status(400).json({ error: "videoIds must contain valid strings" });
      }
      if (new Set(videoIds).size !== videoIds.length) {
        return res.status(400).json({ error: "videoIds must be unique" });
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const acknowledged = appState.db.acknowledgeHighlights(videoIds);
      res.json({ ok: true, requested: videoIds.length, acknowledged });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/:videoId/state", (req, res) => {
    try {
      const allowed = {};
      for (const [bodyKey, dbKey] of [
        ["watched", "watched_at"],
        ["starred", "starred_at"],
        ["hidden", "hidden_at"],
      ]) {
        if (typeof req.body?.[bodyKey] === "boolean") {
          allowed[dbKey] = req.body[bodyKey];
        }
      }
      if (!Object.keys(allowed).length) {
        return res.status(400).json({ error: "watched, starred, or hidden boolean required" });
      }
      res.json({ ok: true, state: appState.db.setVideoState(req.params.videoId, allowed) });
    } catch (err) {
      res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  });

  return router;
};
