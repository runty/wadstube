import { writable, get } from "svelte/store";

export const folders = writable([]);
export const videos = writable([]);
export const activeFolder = writable(null);
export const refreshing = writable(false);
export const error = writable(null);
export const sidebarOpen = writable(false);
export const showChannelsFor = writable(null);
export const toast = writable(null);
export const searchQuery = writable("");
export const activeChannelId = writable(null);

// Live state of an in-progress refresh: total channels, how many finished,
// counts, and up to CHANNEL_CONCURRENCY slots for currently-fetching
// channels.
export const refreshProgress = writable({
  active: false,
  total: 0,
  done: 0,
  newCount: 0,
  errors: 0,
  slots: [], // [{channelId, channelTitle}]
});

// Pagination state for the currently-loaded video list.
export const hasMoreVideos = writable(false);
export const loadingMore = writable(false);

const API = "";

export async function loadFolders() {
  const resp = await fetch(`${API}/api/folders`);
  if (!resp.ok) throw new Error(`Failed to load folders (${resp.status})`);
  folders.set(await resp.json());
}

// Sequence counter so late-arriving responses from a superseded query
// don't stomp the current one (e.g. while you're typing in search).
let _loadSeq = 0;
const _currentQuery = { folder: null, channelId: null, q: null };

function buildVideosUrl({ folder, channelId, q, before, beforeId }) {
  const params = new URLSearchParams();
  if (folder && folder !== "__all__") params.set("folder", folder);
  if (channelId) params.set("channel", channelId);
  if (q) params.set("q", q);
  if (before) params.set("before", before);
  if (beforeId) params.set("before_id", beforeId);
  const s = params.toString();
  return `${API}/api/videos${s ? `?${s}` : ""}`;
}

export async function loadVideos(folder, opts = {}) {
  const channelId = opts.channelId || null;
  const q = opts.q || null;
  const seq = ++_loadSeq;
  _currentQuery.folder = folder;
  _currentQuery.channelId = channelId;
  _currentQuery.q = q;

  const resp = await fetch(buildVideosUrl({ folder, channelId, q }));
  if (!resp.ok) throw new Error(`Failed to load videos (${resp.status})`);
  const data = await resp.json();
  if (seq !== _loadSeq) return; // a newer request has since fired

  videos.set(data.videos || []);
  hasMoreVideos.set(!!data.hasMore);
}

export async function loadMoreVideos() {
  if (get(loadingMore) || !get(hasMoreVideos)) return;
  const current = get(videos);
  if (!current.length) return;
  const tail = current[current.length - 1];
  const before = tail.published;
  const beforeId = tail.video_id;
  loadingMore.set(true);
  const seq = _loadSeq;
  try {
    const resp = await fetch(buildVideosUrl({ ..._currentQuery, before, beforeId }));
    if (!resp.ok) throw new Error(`Failed to load more (${resp.status})`);
    const data = await resp.json();
    // Abandon the page if the user has changed filters in the meantime.
    if (seq !== _loadSeq) return;
    videos.update((v) => [...v, ...(data.videos || [])]);
    hasMoreVideos.set(!!data.hasMore);
  } finally {
    loadingMore.set(false);
  }
}

// --- Folder CRUD ---

export async function createFolderApi(name, parent) {
  const resp = await fetch(`${API}/api/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parent: parent || undefined }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error);
  folders.set(data.folders);
}

export async function renameFolderApi(oldName, newName) {
  const resp = await fetch(`${API}/api/folders/${encodeURIComponent(oldName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newName }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error);
  folders.set(data.folders);
}

export async function deleteFolderApi(name) {
  const resp = await fetch(`${API}/api/folders/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error);
  folders.set(data.folders);
  activeFolder.set("__all__");
  await loadVideos("__all__");
}

// --- Channel management ---

export async function loadChannels(folderName) {
  const resp = await fetch(`${API}/api/folders/${encodeURIComponent(folderName)}/channels`);
  if (!resp.ok) throw new Error(`Failed to load channels (${resp.status})`);
  return await resp.json();
}

export async function addChannelToFolder(folderName, urlOrId) {
  const isUrl = urlOrId.startsWith("http");
  const resp = await fetch(`${API}/api/folders/${encodeURIComponent(folderName)}/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(isUrl ? { url: urlOrId } : { channelId: urlOrId }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error);
  folders.set(data.folders);
  return data;
}

export async function removeChannelFromFolder(folderName, channelId) {
  const resp = await fetch(
    `${API}/api/folders/${encodeURIComponent(folderName)}/channels/${encodeURIComponent(channelId)}`,
    { method: "DELETE" }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error);
  folders.set(data.folders);
}

export async function renameChannelApi(folderName, channelId, newName) {
  const resp = await fetch(
    `${API}/api/folders/${encodeURIComponent(folderName)}/channels/${encodeURIComponent(channelId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error);
  return data;
}

export async function moveChannelApi(sourceFolderName, channelId, destFolderName) {
  const resp = await fetch(
    `${API}/api/folders/${encodeURIComponent(sourceFolderName)}/channels/${encodeURIComponent(channelId)}/move`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destFolder: destFolderName }),
    }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error);
  folders.set(data.folders);
  return data;
}

export async function refreshFolder(folder) {
  refreshing.set(true);
  error.set(null);
  refreshProgress.set({ active: true, total: 0, done: 0, newCount: 0, errors: 0, slots: [] });

  try {
    const url =
      folder && folder !== "__all__"
        ? `${API}/api/refresh/${encodeURIComponent(folder)}`
        : `${API}/api/refresh`;

    const resp = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/x-ndjson" },
    });

    if (!resp.ok) {
      let msg = `Refresh failed (${resp.status})`;
      try {
        const j = await resp.json();
        if (j?.error) msg = j.error;
      } catch {}
      throw new Error(msg);
    }

    let summary = null;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        applyEvent(ev);
        if (ev.type === "summary") summary = ev;
        if (ev.type === "error") throw new Error(ev.error || "Refresh failed");
      }
    }

    // If the server closed the stream without emitting a summary, the
    // refresh finished partially (proxy idle timeout, network blip, etc).
    // Don't pretend it was successful.
    if (!summary) throw new Error("Refresh stream ended before completion");

    await loadVideos(folder, {
      channelId: get(activeChannelId) || null,
      q: get(searchQuery) || null,
    });
    return summary;
  } catch (err) {
    const msg = (err?.message || "").trim() || "Something went wrong";
    if (!err?.message) console.error("refresh failed without a message:", err);
    error.set(msg);
    throw err;
  } finally {
    refreshing.set(false);
    refreshProgress.update((p) => ({ ...p, active: false }));
  }
}

function applyEvent(ev) {
  refreshProgress.update((p) => {
    if (ev.type === "init") {
      return { ...p, total: ev.total, done: 0, newCount: 0, errors: 0, slots: [] };
    }
    if (ev.type === "start") {
      return {
        ...p,
        slots: [...p.slots, { channelId: ev.channelId, channelTitle: ev.channelTitle }],
      };
    }
    if (ev.type === "done") {
      return {
        ...p,
        done: p.done + 1,
        newCount: p.newCount + (ev.newVideos || 0),
        errors: p.errors + (ev.status === "error" ? 1 : 0),
        slots: p.slots.filter((s) => s.channelId !== ev.channelId),
      };
    }
    return p;
  });
}
