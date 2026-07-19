const express = require("express");

const DEFAULT_LIMIT = 200;

module.exports = function (appState) {
  const router = express.Router();
  const { getChannelsForFolder, resolveFolderRouteId } = require("../lib/data");

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
    const view = ["all", "unread", "starred", "hidden"].includes(req.query.view)
      ? req.query.view
      : "all";
    const favorites = req.query.favorites === "1";
    const sort = ["newest", "oldest", "favorite"].includes(req.query.sort)
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
