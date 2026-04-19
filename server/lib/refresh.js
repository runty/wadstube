const { fetchChannelFeed } = require("./rss");
const { checkIsShort } = require("./youtube");

const CHANNEL_CONCURRENCY = 5;
const SHORTS_CONCURRENCY = 10;

let _pLimit;
async function getPLimit() {
  if (!_pLimit) _pLimit = (await import("p-limit")).default;
  return _pLimit;
}

async function classifyNewVideos(db, videos, limit) {
  const fresh = videos.filter((v) => !db.hasVideo(v.video_id));
  if (!fresh.length) return { count: 0, byId: new Map() };
  const classified = await Promise.all(
    fresh.map((v) =>
      limit(async () => ({
        ...v,
        is_short: await checkIsShort(v.video_id),
      })),
    ),
  );
  return {
    count: fresh.length,
    byId: new Map(classified.map((v) => [v.video_id, v])),
  };
}

// Refresh the given channels via RSS, upsert results into the DB, prune to N
// per channel, and classify any newly-seen videos as shorts. Calls onEvent
// with per-channel lifecycle messages so callers can stream progress:
//   { type:"start", channelId, channelTitle }
//   { type:"done",  channelId, channelTitle, status, newVideos, error? }
// Returns a summary { checked, updated, new_videos, errors }.
async function refreshChannels(db, channelIds, opts = {}, onEvent = null) {
  const { keep = 50 } = opts;
  const ids = [...new Set(channelIds)];
  if (!ids.length) return { checked: 0, updated: 0, new_videos: 0, errors: 0 };

  const pLimit = await getPLimit();
  const channelLimit = pLimit(CHANNEL_CONCURRENCY);
  const shortLimit = pLimit(SHORTS_CONCURRENCY);

  let updated = 0;
  let newVideoCount = 0;
  let errors = 0;

  async function processChannel(id) {
    // Cached metadata for conditional GET + "start" event title.
    let meta = db.getChannelMeta(id);
    if (!meta) {
      db.upsertChannel(id, "Unknown");
      meta = { id, title: "Unknown", last_etag: null, last_modified: null };
    }
    if (onEvent) onEvent({ type: "start", channelId: id, channelTitle: meta.title });

    const now = new Date().toISOString();
    const feed = await fetchChannelFeed(id, {
      last_etag: meta.last_etag,
      last_modified: meta.last_modified,
    });

    if (feed.status === "error") {
      errors++;
      if (onEvent)
        onEvent({
          type: "done",
          channelId: id,
          channelTitle: meta.title,
          status: "error",
          newVideos: 0,
          error: feed.error,
        });
      return;
    }

    if (feed.status === "not_modified") {
      db.updateChannelMeta(id, {
        last_checked_at: now,
        last_etag: meta.last_etag,
        last_modified: meta.last_modified,
      });
      if (onEvent)
        onEvent({
          type: "done",
          channelId: id,
          channelTitle: meta.title,
          status: "not_modified",
          newVideos: 0,
        });
      return;
    }

    // ok
    const title = feed.channelTitle || meta.title;
    if (feed.channelTitle) db.upsertChannel(id, feed.channelTitle);

    const { count: newCount, byId } = await classifyNewVideos(
      db,
      feed.videos,
      shortLimit,
    );
    newVideoCount += newCount;

    const toUpsert = feed.videos.map((v) => byId.get(v.video_id) || v);
    db.upsertVideos(toUpsert);
    db.pruneChannel(id, keep);
    db.updateChannelMeta(id, {
      last_checked_at: now,
      last_etag: feed.etag,
      last_modified: feed.lastModified,
    });
    updated++;

    if (onEvent)
      onEvent({
        type: "done",
        channelId: id,
        channelTitle: title,
        status: "ok",
        newVideos: newCount,
      });
  }

  await Promise.all(ids.map((id) => channelLimit(() => processChannel(id))));

  return { checked: ids.length, updated, new_videos: newVideoCount, errors };
}

module.exports = { refreshChannels };
