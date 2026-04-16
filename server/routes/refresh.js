const express = require("express");
const router = express.Router();

module.exports = function (appState) {
  const { getChannelsForFolder, collectAllChannelIds, syncChannelNames, saveData } = require("../lib/data");
  const { fetchChannels } = require("../lib/youtube");

  function syncNamesFromCache() {
    const names = appState.cache.getChannelNames();
    const updated = syncChannelNames(appState.data, names);
    if (updated > 0) {
      saveData(appState.dataDir, appState.data);
      console.log(`Updated ${updated} channel name(s) in tube.json`);
    }
  }

  // Refresh all
  router.post("/", async (req, res) => {
    try {
      const allChannels = [];
      for (const folder of appState.data.folders) {
        allChannels.push(...collectAllChannelIds(folder));
      }
      const unique = [...new Set(allChannels)];
      console.log(`Refreshing all: ${unique.length} channels`);

      const channelVideos = await fetchChannels(appState.apiKey, unique, appState.maxVideos);
      appState.cache.updateChannels(channelVideos);
      syncNamesFromCache();

      const stats = appState.cache.getStats();
      res.json({
        refreshed: Object.keys(channelVideos).length,
        total_channels: stats.channelCount,
        total_videos: stats.videoCount,
      });
    } catch (err) {
      console.error("Refresh all error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Refresh specific folder
  router.post("/:folder", async (req, res) => {
    try {
      const folder = req.params.folder;
      const channelIds = getChannelsForFolder(appState.data, folder);

      if (channelIds.length === 0) {
        return res.status(404).json({ error: `Folder "${folder}" not found` });
      }

      const unique = [...new Set(channelIds)];
      console.log(`Refreshing folder "${folder}": ${unique.length} channels`);

      const channelVideos = await fetchChannels(appState.apiKey, unique, appState.maxVideos);
      appState.cache.updateChannels(channelVideos);
      syncNamesFromCache();

      const videos = appState.cache.getVideosForChannels(channelIds);
      res.json({ refreshed: Object.keys(channelVideos).length, videos });
    } catch (err) {
      console.error(`Refresh ${req.params.folder} error:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
