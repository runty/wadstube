const API_BASE = "https://www.googleapis.com/youtube/v3";
const CONCURRENCY = 20;
const FETCH_TIMEOUT = 10000; // 10 seconds

function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

let _pLimit;
async function getPLimit() {
  if (!_pLimit) {
    _pLimit = (await import("p-limit")).default;
  }
  return _pLimit;
}

async function checkIsShort(videoId) {
  try {
    const resp = await fetchWithTimeout(`https://www.youtube.com/shorts/${videoId}`, {
      method: "HEAD",
      redirect: "manual",
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}

async function fetchPlaylistItems(apiKey, channelId, maxVideos = 15) {
  // Derive uploads playlist ID
  const uploadsId = "UU" + channelId.slice(2);

  // Fetch 50 (the max per call) so that after shorts filtering we still have
  // enough non-short videos. Same API cost as fetching fewer.
  const params = new URLSearchParams({
    part: "snippet",
    playlistId: uploadsId,
    maxResults: "50",
    key: apiKey,
  });

  try {
    const resp = await fetchWithTimeout(`${API_BASE}/playlistItems?${params}`);
    if (!resp.ok) {
      if (resp.status === 403) console.error(`API quota exceeded or forbidden for channel ${channelId}`);
      else if (resp.status !== 404) console.error(`API error ${resp.status} for channel ${channelId}`);
      return [];
    }
    const data = await resp.json();

    const videos = (data.items || [])
      .map((item) => {
        const snippet = item.snippet || {};
        const videoId = snippet.resourceId?.videoId;
        if (!videoId) return null;

        const thumbnails = snippet.thumbnails || {};
        const thumb =
          thumbnails.medium?.url ||
          thumbnails.default?.url ||
          `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

        return {
          video_id: videoId,
          title: snippet.title || "Untitled",
          description: snippet.description || "",
          url: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail: thumb,
          channel: snippet.channelTitle || "Unknown",
          channel_id: snippet.channelId || channelId,
          published: snippet.publishedAt || new Date().toISOString(),
        };
      })
      .filter(Boolean);

    // Filter out shorts (free, no API quota)
    const pLimit = await getPLimit();
    const shortLimit = pLimit(10);
    const shortsChecked = await Promise.all(
      videos.map((v) =>
        shortLimit(async () => {
          const isShort = await checkIsShort(v.video_id);
          return { ...v, isShort };
        })
      )
    );

    return shortsChecked.filter((v) => !v.isShort).slice(0, maxVideos);
  } catch {
    return [];
  }
}

async function fetchChannels(apiKey, channelIds, maxVideos = 15) {
  const pLimit = await getPLimit();
  const limit = pLimit(CONCURRENCY);

  const results = await Promise.all(
    channelIds.map((cid) =>
      limit(() => fetchPlaylistItems(apiKey, cid, maxVideos))
    )
  );

  // Return map of channelId -> videos
  const channelVideos = {};
  channelIds.forEach((cid, i) => {
    if (results[i].length > 0) {
      channelVideos[cid] = {
        fetched_at: new Date().toISOString(),
        videos: results[i],
      };
    }
  });

  return channelVideos;
}

async function resolveUrl(apiKey, url) {
  // Try to parse as a YouTube URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  const hostname = parsed.hostname.replace("www.", "").replace("m.", "");
  if (!["youtube.com", "youtu.be"].includes(hostname)) {
    throw new Error("Not a YouTube URL");
  }

  // Channel URL: /channel/UCxxxx
  const channelMatch = parsed.pathname.match(/^\/channel\/(UC[a-zA-Z0-9_-]+)/);
  if (channelMatch) {
    const channelId = channelMatch[1];
    // Optionally fetch channel title
    const title = await fetchChannelTitle(apiKey, channelId);
    return { channelId, channelTitle: title };
  }

  // Handle URL: /@handle
  const handleMatch = parsed.pathname.match(/^\/@([a-zA-Z0-9_.-]+)/);
  if (handleMatch) {
    const handle = handleMatch[1];
    // Resolve handle to channel ID via search
    const params = new URLSearchParams({
      part: "snippet",
      q: `@${handle}`,
      type: "channel",
      maxResults: "1",
      key: apiKey,
    });
    const resp = await fetchWithTimeout(`${API_BASE}/search?${params}`);
    if (!resp.ok) throw new Error("Failed to resolve handle");
    const data = await resp.json();
    const item = data.items?.[0];
    if (!item) throw new Error(`Channel @${handle} not found`);
    return {
      channelId: item.snippet.channelId,
      channelTitle: item.snippet.channelTitle,
    };
  }

  // Video URL: /watch?v=xxxx or youtu.be/xxxx
  let videoId = parsed.searchParams.get("v");
  if (!videoId && hostname === "youtu.be") {
    videoId = parsed.pathname.slice(1);
  }
  // Also handle /shorts/xxxx and /live/xxxx
  if (!videoId) {
    const pathMatch = parsed.pathname.match(/^\/(shorts|live)\/([a-zA-Z0-9_-]+)/);
    if (pathMatch) videoId = pathMatch[2];
  }

  if (videoId) {
    // Resolve video to channel
    const params = new URLSearchParams({
      part: "snippet",
      id: videoId,
      key: apiKey,
    });
    const resp = await fetchWithTimeout(`${API_BASE}/videos?${params}`);
    if (!resp.ok) throw new Error("Failed to resolve video");
    const data = await resp.json();
    const item = data.items?.[0];
    if (!item) throw new Error(`Video ${videoId} not found`);
    return {
      channelId: item.snippet.channelId,
      channelTitle: item.snippet.channelTitle,
    };
  }

  throw new Error("Could not parse YouTube URL");
}

async function fetchChannelTitle(apiKey, channelId) {
  try {
    const params = new URLSearchParams({
      part: "snippet",
      id: channelId,
      key: apiKey,
    });
    const resp = await fetchWithTimeout(`${API_BASE}/channels?${params}`);
    if (!resp.ok) return "Unknown";
    const data = await resp.json();
    return data.items?.[0]?.snippet?.title || "Unknown";
  } catch {
    return "Unknown";
  }
}

module.exports = { fetchChannels, resolveUrl };
