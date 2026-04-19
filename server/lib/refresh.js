const { fetchAllFeeds } = require("./rss");
const { checkIsShort } = require("./youtube");

const SHORTS_CONCURRENCY = 10;

let _pLimit;
async function getPLimit() {
  if (!_pLimit) _pLimit = (await import("p-limit")).default;
  return _pLimit;
}

// Refresh the given channels via RSS, upsert results into the DB, prune to N
// per channel, and classify any new videos as shorts via HEAD request.
// Returns a summary { checked, updated, new_videos, errors }.
async function refreshChannels(db, channelIds, { keep = 50 } = {}) {
  const ids = [...new Set(channelIds)];
  if (!ids.length) return { checked: 0, updated: 0, new_videos: 0, errors: 0 };

  // Ensure every channel row exists so RSS metadata can hang off it.
  const channels = ids.map((id) => {
    const meta = db.getChannelMeta(id);
    if (!meta) db.upsertChannel(id, "Unknown");
    return meta || { id, last_etag: null, last_modified: null };
  });

  const feeds = await fetchAllFeeds(channels);
  const pLimit = await getPLimit();
  const shortLimit = pLimit(SHORTS_CONCURRENCY);
  const now = new Date().toISOString();

  let updated = 0;
  let newVideoCount = 0;
  let errors = 0;

  for (const feed of feeds) {
    if (feed.status === "error") {
      errors++;
      continue;
    }

    if (feed.status === "not_modified") {
      db.updateChannelMeta(feed.channelId, {
        last_checked_at: now,
        last_etag: channels.find((c) => c.id === feed.channelId)?.last_etag,
        last_modified: channels.find((c) => c.id === feed.channelId)
          ?.last_modified,
      });
      continue;
    }

    // ok
    if (feed.channelTitle) db.upsertChannel(feed.channelId, feed.channelTitle);

    // Classify shorts only for videos we haven't seen before.
    const fresh = feed.videos.filter((v) => !db.hasVideo(v.video_id));
    newVideoCount += fresh.length;

    const classified = await Promise.all(
      fresh.map((v) =>
        shortLimit(async () => ({
          ...v,
          is_short: await checkIsShort(v.video_id),
        })),
      ),
    );
    const byId = new Map(classified.map((v) => [v.video_id, v]));

    // Build final list: classified for fresh ones, is_short=0 for existing
    // (ignored by ON CONFLICT UPDATE).
    const toUpsert = feed.videos.map((v) => byId.get(v.video_id) || v);
    db.upsertVideos(toUpsert);
    db.pruneChannel(feed.channelId, keep);
    db.updateChannelMeta(feed.channelId, {
      last_checked_at: now,
      last_etag: feed.etag,
      last_modified: feed.lastModified,
    });
    updated++;
  }

  return { checked: ids.length, updated, new_videos: newVideoCount, errors };
}

module.exports = { refreshChannels };
