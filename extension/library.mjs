export const APP_ORIGIN = 'https://wadstube.runty.org';
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function videoIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/shorts\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    return VIDEO_ID.test(id || '') ? id : null;
  } catch { return null; }
}

export function flattenFolders(tree, parents = []) {
  if (!Array.isArray(tree) || parents.length >= 4) return [];
  return tree.flatMap(folder => {
    if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string') return [];
    const path = [...parents, folder.name];
    return [{ id: folder.id, name: folder.name, parent: parents.join(' / '), path: path.join(' / '),
      depth: parents.length, added: folder.containsChannel === true }, ...flattenFolders(folder.children, path)];
  });
}

export function savePayload(channel) {
  if (!channel || !VIDEO_ID.test(channel.videoId || '')) throw new Error('Open a YouTube video and try again.');
  return CHANNEL_ID.test(channel.channelId || '')
    ? { channelId: channel.channelId, channelName: String(channel.name || '').slice(0, 200) }
    : { url: `https://www.youtube.com/watch?v=${channel.videoId}` };
}

export async function libraryRequest(path, body) {
  let response;
  try {
    response = await fetch(APP_ORIGIN + path, { method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25_000) });
    if (response.ok) return await response.json();
    await response.body?.cancel();
  } catch {
    throw new Error(body ? 'Could not confirm the save. Reconnect to Tailscale and retry; adding the same channel twice is safe.'
      : 'Cannot reach WadsTube. Check Tailscale and make sure your app is available.');
  }
  if (response.status === 403) throw new Error('Access was blocked. Check Tailscale and that the companion server update is enabled.');
  if (response.status === 429) throw new Error('A few too many requests. Wait a minute, then try again.');
  if (response.status === 409) throw new Error('WadsTube is busy. Wait for the current operation, then retry.');
  if (response.status === 404) throw new Error('This group no longer exists. Reload your groups and choose another.');
  if (response.status === 400) throw new Error('Could not resolve this channel. Reload the YouTube video and try again; URL fallback needs a server YouTube API key.');
  throw new Error('WadsTube could not complete the request. Retry in a moment.');
}
