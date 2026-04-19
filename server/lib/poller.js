const { refreshChannels } = require("./refresh");

// Start a background timer that refreshes all channels via RSS every
// `intervalMinutes`. A value of 0 disables the poller entirely. While a
// manual refresh is in flight (appState.refreshLock), the tick waits for
// it to finish before running its own pass.
function startPoller(appState, { intervalMinutes, collectAllChannelIds, syncChannelNames, saveData }) {
  if (!intervalMinutes || intervalMinutes <= 0) {
    console.log("[poller] disabled (REFRESH_INTERVAL_MINUTES=0)");
    return;
  }

  const intervalMs = intervalMinutes * 60_000;
  let running = false;

  async function tick() {
    if (running) {
      console.log("[poller] previous tick still running, skipping");
      return;
    }
    running = true;
    try {
      if (appState.refreshLock) await appState.refreshLock;

      const ids = [];
      for (const folder of appState.data.folders) {
        ids.push(...collectAllChannelIds(folder));
      }
      const unique = [...new Set(ids)];
      if (unique.length === 0) return;

      let release;
      appState.refreshLock = new Promise((res) => { release = res; });
      try {
        const summary = await refreshChannels(appState.db, unique, {
          keep: appState.maxVideos,
          mode: appState.pollerMode,
          apiKey: appState.apiKey,
        });
        const names = appState.db.getChannelNames();
        const updated = syncChannelNames(appState.data, names);
        if (updated > 0) saveData(appState.dataDir, appState.data);
        console.log(
          `[poller] checked ${summary.checked} channels, ` +
            `${summary.updated} with updates, ${summary.new_videos} new videos, ` +
            `${summary.errors} errors`,
        );
      } finally {
        release();
        appState.refreshLock = null;
      }
    } catch (err) {
      console.error(`[poller] tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  console.log(`[poller] refreshing every ${intervalMinutes}m`);
  // Offset the first tick a bit so it doesn't collide with startup work.
  const firstDelay = Math.min(intervalMs, 60_000);
  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs);
  }, firstDelay);
}

module.exports = { startPoller };
