const express = require("express");
const router = express.Router();

module.exports = function (appState) {
  const { getChannelsForFolder, collectAllChannelIds, syncChannelNames, saveData } =
    require("../lib/data");
  const { refreshChannels } = require("../lib/refresh");

  function syncNamesFromDb() {
    const names = appState.db.getChannelNames();
    const updated = syncChannelNames(appState.data, names);
    if (updated > 0) {
      saveData(appState.dataDir, appState.data);
      console.log(`Updated ${updated} channel name(s) in tube.json`);
    }
  }

  async function runRefresh(channelIds) {
    // Serialize against the background poller so we don't race.
    if (appState.refreshLock) {
      await appState.refreshLock;
    }
    let release;
    appState.refreshLock = new Promise((res) => { release = res; });
    try {
      const summary = await refreshChannels(appState.db, channelIds, {
        keep: appState.maxVideos,
      });
      syncNamesFromDb();
      return summary;
    } finally {
      release();
      appState.refreshLock = null;
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

      const summary = await runRefresh(unique);
      console.log(
        `Refresh all done: ${summary.updated} with updates, ` +
          `${summary.new_videos} new videos, ${summary.errors} errors`,
      );
      const stats = appState.db.getStats();
      res.json({
        refreshed: summary.updated,
        new_videos: summary.new_videos,
        errors: summary.errors,
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

      const summary = await runRefresh(unique);
      console.log(
        `Refresh "${folder}" done: ${summary.updated} with updates, ` +
          `${summary.new_videos} new videos, ${summary.errors} errors`,
      );
      const videos = appState.db.getVideosForChannels(channelIds);
      res.json({
        refreshed: summary.updated,
        new_videos: summary.new_videos,
        errors: summary.errors,
        videos,
      });
    } catch (err) {
      console.error(`Refresh ${req.params.folder} error:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
