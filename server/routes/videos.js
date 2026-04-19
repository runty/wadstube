const express = require("express");
const router = express.Router();

const DEFAULT_LIMIT = 200;

module.exports = function (appState) {
  const { getChannelsForFolder } = require("../lib/data");

  router.get("/", (req, res) => {
    const folder = req.query.folder;
    const channelId = req.query.channel || undefined;
    const q = req.query.q || undefined;
    const before = req.query.before || undefined;
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
      500,
    );

    // Resolve folder → channel-id set. "__all__" (or missing) means no
    // folder filter; the DB still restricts to non-shorts.
    let channelIds;
    if (folder && folder !== "__all__") {
      channelIds = getChannelsForFolder(appState.data, folder);
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
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    if (hasMore) rows.length = limit;

    res.json({ videos: rows, hasMore });
  });

  return router;
};
