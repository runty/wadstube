// Runs once in the active YouTube tab when the user opens the popup. This must
// stay self-contained: Chrome serializes this function into the page's world.
export function readYouTubeChannel() {
  const url = new URL(location.href);
  const videoId = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/shorts\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) || !/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return null;
  const shorts = url.pathname.startsWith('/shorts/');
  const root = shorts ? document.querySelector('ytd-reel-video-renderer[is-active]') : document.querySelector('ytd-watch-flexy');
  const player = root?.querySelector('#movie_player') || (!shorts ? document.querySelector('#movie_player') : null);
  let details;
  try { details = player?.getVideoData?.(); } catch { /* Page APIs are optional. */ }
  if (details?.video_id !== videoId) details = null;
  let response;
  try { response = player?.getPlayerResponse?.()?.videoDetails; } catch { /* Page APIs are optional. */ }
  const initial = window.ytInitialPlayerResponse?.videoDetails;
  // getVideoData can identify the current video without providing channel_id.
  // Fill missing fields from a response for this exact video, never stale SPA data.
  for (const candidate of [response, initial]) {
    if (candidate?.videoId !== videoId) continue;
    details = { author: candidate.author, title: candidate.title,
      ...details, channel_id: /^UC[A-Za-z0-9_-]{22}$/.test(details?.channel_id || '') ? details.channel_id : candidate.channelId };
  }
  // Do not reuse a watch page's previous owner during YouTube SPA navigation.
  const rootMatches = shorts ? !!details : root?.getAttribute('video-id') === videoId;
  const owner = rootMatches ? root?.querySelector(shorts ? '#channel-name' : '#owner #channel-name') : null;
  const link = owner?.querySelector('a[href]');
  const href = link?.getAttribute('href') || '';
  const domId = /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/.exec(href)?.[1];
  const channelId = details?.channel_id || domId || null;
  const name = String(details?.author || owner?.textContent || '').trim().slice(0, 200);
  const avatar = rootMatches ? root?.querySelector(shorts ? '#avatar img' : '#owner #avatar img')?.src : null;
  return { videoId, channelId: /^UC[A-Za-z0-9_-]{22}$/.test(channelId || '') ? channelId : null,
    name: name || 'YouTube channel', title: String(details?.title || '').slice(0, 300),
    handle: /^\/@[^/?#]+/.exec(href)?.[0].slice(1) || '',
    avatar: typeof avatar === 'string' && /^https:\/\/yt3\.(ggpht\.com|googleusercontent\.com)\//.test(avatar) ? avatar : null };
}
