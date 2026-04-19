const { XMLParser } = require("fast-xml-parser");

const FEED_BASE = "https://www.youtube.com/feeds/videos.xml";
// Keep concurrency low — YouTube's RSS endpoint starts returning 404/5xx
// under bursty traffic from a single IP. With ~2k channels, a wider fan-out
// tripped the throttle on nearly every request during manual refreshes.
const CONCURRENCY = 5;
const FETCH_TIMEOUT = 10000;
// Exponential retry delays in ms; length = number of retries after the
// initial attempt.
const RETRY_DELAYS_MS = [1000, 3000];
const USER_AGENT = "WadsTube/1.0 (+https://github.com/phobus/wadstube)";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
});

function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

let _pLimit;
async function getPLimit() {
  if (!_pLimit) _pLimit = (await import("p-limit")).default;
  return _pLimit;
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function pickThumbnail(entry, videoId) {
  const thumbs = asArray(entry.group?.thumbnail);
  const first = thumbs[0];
  const url = typeof first === "object" ? first["@_url"] : null;
  return url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

function pickString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in v) return v["#text"] || "";
  return String(v);
}

function parseFeed(xml, channelId) {
  const parsed = parser.parse(xml);
  const feed = parsed.feed;
  if (!feed) return { channelTitle: null, videos: [] };

  const channelTitle = pickString(feed.author?.name) || pickString(feed.title) || null;
  const entries = asArray(feed.entry);

  const videos = [];
  for (const entry of entries) {
    const videoId = entry.videoId;
    if (!videoId) continue;
    videos.push({
      video_id: videoId,
      channel_id: entry.channelId || channelId,
      title: pickString(entry.title) || "Untitled",
      description: pickString(entry.group?.description) || "",
      thumbnail: pickThumbnail(entry, videoId),
      published: entry.published || new Date().toISOString(),
    });
  }
  return { channelTitle, videos };
}

async function fetchOnce(channelId, cached) {
  const url = `${FEED_BASE}?channel_id=${encodeURIComponent(channelId)}`;
  const headers = { "User-Agent": USER_AGENT };
  if (cached.last_etag) headers["If-None-Match"] = cached.last_etag;
  if (cached.last_modified) headers["If-Modified-Since"] = cached.last_modified;
  return fetchWithTimeout(url, { headers });
}

// Result shape:
//   { channelId, status: "ok" | "not_modified" | "error", videos, channelTitle,
//     etag, lastModified, error? }
async function fetchChannelFeed(channelId, cached = {}) {
  let resp;
  let lastErr;
  try {
    resp = await fetchOnce(channelId, cached);
    for (const delay of RETRY_DELAYS_MS) {
      if (resp.status < 500 && resp.status !== 404) break;
      await new Promise((r) => setTimeout(r, delay));
      resp = await fetchOnce(channelId, cached);
    }
  } catch (err) {
    lastErr = err;
  }

  if (!resp) {
    return { channelId, status: "error", videos: [], error: lastErr?.message || "fetch failed" };
  }

  if (resp.status === 304) {
    return { channelId, status: "not_modified", videos: [] };
  }
  if (!resp.ok) {
    return {
      channelId,
      status: "error",
      videos: [],
      error: `HTTP ${resp.status}`,
    };
  }

  const xml = await resp.text();
  const { channelTitle, videos } = parseFeed(xml, channelId);
  return {
    channelId,
    status: "ok",
    videos,
    channelTitle,
    etag: resp.headers.get("etag"),
    lastModified: resp.headers.get("last-modified"),
  };
}

// channels: [{ id, last_etag, last_modified }]
async function fetchAllFeeds(channels) {
  const pLimit = await getPLimit();
  const limit = pLimit(CONCURRENCY);
  return Promise.all(
    channels.map((c) =>
      limit(() =>
        fetchChannelFeed(c.id, {
          last_etag: c.last_etag,
          last_modified: c.last_modified,
        }),
      ),
    ),
  );
}

module.exports = { fetchChannelFeed, fetchAllFeeds };
