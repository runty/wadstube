const fs = require("fs");
const path = require("path");
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

// One-time import of the legacy cache.json blob into SQLite. Runs on boot
// when the DB has no channel rows and cache.json exists. The old cache was
// already shorts-filtered, so we mark every imported row is_short = 0.
function migrateCacheJsonIfNeeded(db, dataDir) {
  const stats = db.getStats();
  if (stats.channelCount > 0) return { imported: 0, skipped: "db-not-empty" };

  const cacheFile = path.join(dataDir, "cache.json");
  if (!fs.existsSync(cacheFile)) return { imported: 0, skipped: "no-cache" };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  } catch (err) {
    console.error(`[migrate-cache] failed to parse cache.json: ${err.message}`);
    return { imported: 0, skipped: "parse-error" };
  }

  const channels = data?.channels || {};
  let videoCount = 0;
  let channelCount = 0;

  for (const [channelId, entry] of Object.entries(channels)) {
    if (!CHANNEL_ID_RE.test(channelId)) continue;
    const videos = entry?.videos || [];
    if (!videos.length) continue;
    const title = videos[0]?.channel || "Unknown";
    db.upsertChannel(channelId, title);
    channelCount++;
    const rows = videos.map((v) => ({
      video_id: v.video_id,
      channel_id: channelId,
      title: v.title || "Untitled",
      description: v.description || "",
      thumbnail: v.thumbnail || "",
      published: v.published || new Date().toISOString(),
      is_short: 0,
    }));
    db.upsertVideos(rows);
    videoCount += rows.length;
  }

  // Park the old cache file aside so the import doesn't re-run.
  const archived = cacheFile + ".migrated";
  try {
    fs.renameSync(cacheFile, archived);
  } catch (err) {
    console.error(`[migrate-cache] failed to rename cache.json: ${err.message}`);
  }

  console.log(
    `[migrate-cache] imported ${videoCount} videos across ${channelCount} channels; moved cache.json → cache.json.migrated`,
  );
  return { imported: videoCount, channels: channelCount };
}

module.exports = { migrateCacheJsonIfNeeded };
