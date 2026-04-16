const express = require("express");
const router = express.Router();

module.exports = function (appState) {
  const { getChannelsForFolder } = require("../lib/data");

  router.get("/", (req, res) => {
    const folder = req.query.folder;

    if (!folder || folder === "__all__") {
      return res.json(appState.cache.getAllVideos());
    }

    const channelIds = getChannelsForFolder(appState.data, folder);
    if (channelIds.length === 0) {
      return res.json([]);
    }

    res.json(appState.cache.getVideosForChannels(channelIds));
  });

  return router;
};
