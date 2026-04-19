const API_BASE = "https://www.googleapis.com/youtube/v3";
const FETCH_TIMEOUT = 10000;

function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// Free shorts detection via HEAD request to the /shorts/ URL.
async function checkIsShort(videoId) {
  try {
    const resp = await fetchWithTimeout(
      `https://www.youtube.com/shorts/${videoId}`,
      { method: "HEAD", redirect: "manual" },
    );
    return resp.status === 200;
  } catch {
    return false;
  }
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

async function resolveUrl(apiKey, url) {
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
    const title = await fetchChannelTitle(apiKey, channelId);
    return { channelId, channelTitle: title };
  }

  // Handle URL: /@handle
  const handleMatch = parsed.pathname.match(/^\/@([a-zA-Z0-9_.-]+)/);
  if (handleMatch) {
    const handle = handleMatch[1];
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
  if (!videoId) {
    const pathMatch = parsed.pathname.match(
      /^\/(shorts|live)\/([a-zA-Z0-9_-]+)/,
    );
    if (pathMatch) videoId = pathMatch[2];
  }

  if (videoId) {
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

module.exports = { resolveUrl, checkIsShort };
