const API_BASE = "https://www.googleapis.com/youtube/v3";
const { fetchBuffered } = require("./fetch");
const { recordNetwork } = require("./quota");

function apiKeyRequired(action) {
  const err = new Error(`YOUTUBE_API_KEY is required to ${action}`);
  err.code = "apiKeyRequired";
  return err;
}

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function httpStatusForYoutubeError(err, fallback = 500) {
  const code = String(err?.code || "").toLowerCase();
  if (
    code.includes("quota") ||
    code.includes("ratelimit") ||
    code === "dailylimitexceeded"
  ) {
    return 429;
  }
  if (code === "notfound" || code.endsWith("notfound")) return 404;
  if (
    code === "invalidinput" ||
    code.includes("invalidparameter") ||
    code === "badrequest"
  ) {
    return 400;
  }
  if (code === "apikeyrequired") return 503;
  if (
    code === "youtubeunavailable" ||
    code.includes("keyinvalid") ||
    code.includes("accessnotconfigured") ||
    code === "forbidden" ||
    Number(err?.status) >= 500 ||
    [401, 403].includes(Number(err?.status))
  ) {
    return 502;
  }
  return fallback;
}

function parseApiError(resp, text, action) {
  let reason = `HTTP ${resp.status}`;
  let message = resp.statusText || "YouTube API request failed";
  try {
    const body = JSON.parse(text);
    const detail = body?.error?.errors?.[0];
    reason = detail?.reason || body?.error?.status || reason;
    message = detail?.message || body?.error?.message || message;
  } catch {}

  const err = new Error(`${action} failed (${reason}): ${message}`);
  err.code = reason;
  err.status = resp.status;
  return err;
}

async function youtubeApiRequest(apiKey, resource, params, action, context = {}) {
  if (!apiKey) throw apiKeyRequired(action);
  const endpoint = `${resource}.list`;
  context.quota?.reserve(endpoint, { metrics: context.metrics });
  let resp;
  let text;
  try {
    ({ response: resp, text } = await fetchBuffered(
      `${API_BASE}/${resource}?${new URLSearchParams(params)}`,
      { headers: { "x-goog-api-key": apiKey } },
    ));
  } catch (err) {
    err.code = "youtubeUnavailable";
    throw err;
  }
  if (!resp.ok) throw parseApiError(resp, text, action);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("response body was not a JSON object");
    }
    return data;
  } catch (err) {
    err.code = "youtubeUnavailable";
    err.status = 502;
    err.message = `${action} failed: YouTube returned an invalid JSON response`;
    throw err;
  }
}

// Free Shorts detection via HEAD request to the /shorts/ URL. A transient or
// unexpected response remains unknown so a later refresh can retry it.
async function checkIsShort(videoId, metrics = null) {
  try {
    recordNetwork(metrics, "shorts");
    const { response: resp } = await fetchBuffered(
      `https://www.youtube.com/shorts/${videoId}`,
      { method: "HEAD", redirect: "manual" },
    );
    if (resp.status === 200) return "short";
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("location");
      if (!location) return "unknown";
      const target = new URL(location, "https://www.youtube.com");
      // Consent/login/interstitial redirects do not establish video format.
      if (target.protocol === "https:" && !target.username && !target.password &&
          ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(target.host) &&
          target.pathname === "/watch" && target.searchParams.get("v") === videoId) return "long";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function resolveUrl(apiKey, url, context = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw codedError("Invalid URL", "invalidInput");
  }

  const hostname = parsed.hostname.replace(/^(www\.|m\.)/, "");
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !["youtube.com", "youtu.be"].includes(hostname)) {
    throw codedError("Not a YouTube URL", "invalidInput");
  }

  // A canonical channel URL contains the final channel ID, so it works in an
  // RSS-only installation without an API key. The next refresh fills in the
  // channel title.
  const channelMatch = parsed.pathname.match(
    /^\/channel\/(UC[A-Za-z0-9_-]{22})\/?$/,
  );
  if (channelMatch) {
    const channelId = channelMatch[1];
    return { channelId, channelTitle: "Unknown" };
  }

  // channels.list(forHandle=...) is exact and avoids the separate daily
  // search.list call limit.
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); }
  catch { throw codedError("Malformed URL encoding", "invalidInput"); }
  // Let YouTube validate its international alphabet; reject path/control syntax.
  const handleMatch = hostname === "youtube.com" && pathname.match(/^\/@([^\s/\\?#@\p{Cc}]+)(?:\/(?:videos|shorts|streams|featured|playlists|community|about))?\/?$/u);
  if (handleMatch) {
    const handle = handleMatch[1];
    const data = await youtubeApiRequest(
      apiKey,
      "channels",
      {
        part: "snippet",
        forHandle: `@${handle}`,
        fields: "items(id,snippet/title)",
      },
      `resolve @${handle}`,
      context,
    );
    const item = data.items?.[0];
    if (!item) throw codedError(`Channel @${handle} not found`, "notFound");
    return {
      channelId: item.id,
      channelTitle: item.snippet?.title || "Unknown",
    };
  }

  // Video URL: /watch?v=xxxx, /shorts/xxxx, /live/xxxx or youtu.be/xxxx.
  let videoId = parsed.searchParams.get("v");
  if (!videoId && hostname === "youtu.be") videoId = parsed.pathname.slice(1);
  if (!videoId) {
    const pathMatch = parsed.pathname.match(/^\/(shorts|live)\/([A-Za-z0-9_-]+)/);
    if (pathMatch) videoId = pathMatch[2];
  }

  if (videoId && /^[A-Za-z0-9_-]+$/.test(videoId)) {
    const data = await youtubeApiRequest(
      apiKey,
      "videos",
      {
        part: "snippet",
        id: videoId,
        fields: "items(snippet/channelId,snippet/channelTitle)",
      },
      `resolve video ${videoId}`,
      context,
    );
    const item = data.items?.[0];
    if (!item) throw codedError(`Video ${videoId} not found`, "notFound");
    return {
      channelId: item.snippet.channelId,
      channelTitle: item.snippet.channelTitle,
    };
  }

  throw codedError("Could not parse YouTube URL", "invalidInput");
}

// Fetch recent uploads via the YouTube Data API's playlistItems endpoint.
// Costs 1 general quota unit per channel call under the June 2026 model.
async function fetchChannelViaApi(apiKey, channelId, context = {}) {
  const uploadsId = "UU" + channelId.slice(2);
  let data;
  try {
    data = await youtubeApiRequest(
      apiKey,
      "playlistItems",
      {
        part: "snippet,contentDetails",
        playlistId: uploadsId,
        maxResults: "50",
        fields:
          "items(contentDetails/videoPublishedAt,snippet(channelId,channelTitle,title,description,resourceId/videoId,thumbnails/default/url,thumbnails/medium/url))",
      },
      `refresh channel ${channelId}`,
      context,
    );
  } catch (err) {
    return {
      channelId,
      status: "error",
      videos: [],
      error: err.message,
      errorCode: err.code || null,
    };
  }

  let channelTitle = null;
  const videos = [];
  for (const item of data.items || []) {
    const snippet = item.snippet || {};
    const videoId = snippet.resourceId?.videoId;
    if (!videoId) continue;
    // Playlist-add time is not video publication time. Missing/private entries
    // are omitted until YouTube supplies a real date; never manufacture "now".
    // https://developers.google.com/youtube/v3/docs/playlistItems
    const published = item.contentDetails?.videoPublishedAt;
    if (!published || !Number.isFinite(Date.parse(published))) continue;
    if (!channelTitle) channelTitle = snippet.channelTitle || null;
    const thumbs = snippet.thumbnails || {};
    const thumb =
      thumbs.medium?.url ||
      thumbs.default?.url ||
      `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    videos.push({
      video_id: videoId,
      channel_id: snippet.channelId || channelId,
      title: snippet.title || "Untitled",
      description: snippet.description || "",
      thumbnail: thumb,
      published: new Date(published).toISOString(),
    });
  }

  return { channelId, status: "ok", source: "api", videos, channelTitle };
}

module.exports = {
  resolveUrl,
  checkIsShort,
  fetchChannelViaApi,
  youtubeApiRequest,
  httpStatusForYoutubeError,
};
