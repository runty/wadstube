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

  async function runRefresh(channelIds, onEvent) {
    let release;
    appState.refreshLock = new Promise((res) => { release = res; });
    try {
      const summary = await refreshChannels(
        appState.db,
        channelIds,
        { keep: appState.maxVideos },
        onEvent,
      );
      syncNamesFromDb();
      return summary;
    } finally {
      release();
      appState.refreshLock = null;
    }
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
      const summary = await runRefresh(channelIds, onEvent);
      console.log(
        `Refresh ${meta.label || "all"} done: ${summary.updated} with updates, ` +
          `${summary.new_videos} new videos, ${summary.errors} errors`,
      );
      const stats = appState.db.getStats();
      const videos = meta.folder
        ? appState.db.getVideosForChannels(meta.channelIdsForFolder || channelIds)
        : undefined;
      writeEvent(res, {
        type: "summary",
        refreshed: summary.updated,
        new_videos: summary.new_videos,
        errors: summary.errors,
        total_channels: stats.channelCount,
        total_videos: stats.videoCount,
        videos,
      });
    } catch (err) {
      console.error(`Refresh ${meta.label || "all"} error:`, err);
      writeEvent(res, { type: "error", error: err.message });
    } finally {
      res.end();
    }
  }

  function rejectIfBusy(res) {
    if (!appState.refreshLock) return false;
    res
      .status(409)
      .json({ error: "A refresh is already running (either manual or the background poller). Try again in a moment." });
    return true;
  }

  // Refresh all
  router.post("/", async (req, res) => {
    if (rejectIfBusy(res)) return;
    const allChannels = [];
    for (const folder of appState.data.folders) {
      allChannels.push(...collectAllChannelIds(folder));
    }
    const unique = [...new Set(allChannels)];
    console.log(`Refreshing all: ${unique.length} channels`);
    await streamRefresh(req, res, unique, { label: "all" });
  });

  // Refresh specific folder
  router.post("/:folder", async (req, res) => {
    if (rejectIfBusy(res)) return;
    const folder = req.params.folder;
    const channelIds = getChannelsForFolder(appState.data, folder);
    if (channelIds.length === 0) {
      res.status(404).json({ error: `Folder "${folder}" not found` });
      return;
    }
    const unique = [...new Set(channelIds)];
    console.log(`Refreshing folder "${folder}": ${unique.length} channels`);
    await streamRefresh(req, res, unique, {
      label: `"${folder}"`,
      folder,
      channelIdsForFolder: channelIds,
    });
  });

  return router;
};
