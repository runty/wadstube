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
export const viewFilter = writable("all");
export const favoritesOnly = writable(false);
export const density = writable("grid");
export const sortOrder = writable("newest");
export const showHealth = writable(false);
export const channelHealth = writable([]);
export const healthFilter = writable("all");
export const quotaStatus = writable(null);
export const refreshRuns = writable([]);
// One shared channel-list cache prevents recursive sidebar nodes and the
// management dialog from showing conflicting favorite/unread metadata.
export const channelLists = writable({});
const channelLoads = new Map();
const channelControllers = new Map();
let channelCacheGeneration = 0;
export function clearChannelLists() {
  channelCacheGeneration++;
  for (const controller of channelControllers.values()) controller.abort();
  channelControllers.clear();
  channelLists.set({});
  channelLoads.clear();
}

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

export async function resetAfterSubscriptionImport() {
  clearChannelLists();
  activeFolder.set("__all__");
  activeChannelId.set(null);
  searchQuery.set("");
  const results = await Promise.allSettled([
    loadFolders(),
    loadVideos("__all__", { channelId: null, q: null }),
  ]);
  return { reloadFailures: results.filter((result) => result.status === "rejected").length };
}

// Sequence counter so late-arriving responses from a superseded query
// don't stomp the current one (e.g. while you're typing in search).
let _loadSeq = 0;
const _currentQuery = { folder: null, channelId: null, q: null };
let _abortController;

function buildVideosUrl({ folder, channelId, q, before, beforeId, beforeFavorite, beforeReturning, view, favorites, sort }) {
  const params = new URLSearchParams();
  if (folder && folder !== "__all__") params.set("folder", folder);
  if (channelId) params.set("channel", channelId);
  if (q) params.set("q", q);
  if (before) params.set("before", before);
  if (beforeId) params.set("before_id", beforeId);
  if (beforeFavorite) params.set("before_favorite", "1");
  if (beforeReturning) params.set("before_returning", "1");
  if (view && view !== "all") params.set("view", view);
  if (favorites) params.set("favorites", "1");
  if (sort && sort !== "newest") params.set("sort", sort);
  const s = params.toString();
  return `${API}/api/videos${s ? `?${s}` : ""}`;
}

export async function loadVideos(folder, opts = {}) {
  const channelId = opts.channelId || null;
  const q = opts.q || null;
  const view = opts.view || get(viewFilter);
  const favorites = opts.favorites ?? get(favoritesOnly);
  const sort = opts.sort || get(sortOrder);
  const seq = ++_loadSeq;
  _currentQuery.folder = folder;
  _currentQuery.channelId = channelId;
  _currentQuery.q = q;
  _currentQuery.view = view;
  _currentQuery.favorites = favorites;
  _currentQuery.sort = sort;

  _abortController?.abort();
  _abortController = new AbortController();
  let resp;
  try {
    resp = await fetch(buildVideosUrl({ folder, channelId, q, view, favorites, sort }), {
      signal: _abortController.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    throw err;
  }
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
  const beforeFavorite = tail.channel_favorite;
  const beforeReturning = !!tail.highlight_reason;
  loadingMore.set(true);
  const seq = _loadSeq;
  try {
    const resp = await fetch(buildVideosUrl({ ..._currentQuery, before, beforeId, beforeFavorite, beforeReturning }));
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
  clearChannelLists();
  activeFolder.set("__all__");
  activeChannelId.set(null);
  await loadVideos("__all__");
}

// --- Channel management ---

export async function loadChannels(folderId, force = false) {
  const cachedState = get(channelLists);
  const cached = Object.hasOwn(cachedState, folderId) ? cachedState[folderId] : undefined;
  if (!force && cached) return cached;
  if (!force && channelLoads.has(folderId)) return channelLoads.get(folderId);
  if (force) channelControllers.get(folderId)?.abort();
  const controller = new AbortController();
  const generation = channelCacheGeneration;
  channelControllers.set(folderId, controller);
  const request = (async () => {
    try {
      const resp = await fetch(`${API}/api/folders/${encodeURIComponent(folderId)}/channels`, {
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`Failed to load channels (${resp.status})`);
      const rows = await resp.json();
      if (generation === channelCacheGeneration && channelControllers.get(folderId) === controller) {
        channelLists.update((all) => ({ ...all, [folderId]: rows }));
      }
      return rows;
    } catch (err) {
      if (err.name === "AbortError") {
        const current = get(channelLists);
        return Object.hasOwn(current, folderId) ? current[folderId] : [];
      }
      throw err;
    }
  })();
  channelLoads.set(folderId, request);
  try { return await request; }
  finally {
    if (channelLoads.get(folderId) === request) channelLoads.delete(folderId);
    if (channelControllers.get(folderId) === controller) channelControllers.delete(folderId);
  }
}

async function reloadCachedChannelLists() {
  const ids = Object.keys(get(channelLists));
  await Promise.allSettled(ids.map((id) => loadChannels(id, true)));
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
  await loadChannels(folderName, true);
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
  await loadChannels(folderName, true);
  if (get(activeChannelId) === channelId) {
    activeChannelId.set(null);
  }
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
  await reloadCachedChannelLists();
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
  await Promise.all([loadChannels(sourceFolderName, true), loadChannels(destFolderName, true)]);
  if (get(activeChannelId) === channelId) {
    activeFolder.set(destFolderName);
  }
  return data;
}

export async function setVideoState(videoId, changes) {
  const resp = await fetch(`${API}/api/videos/${encodeURIComponent(videoId)}/state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "Failed to update video");
  const state = data.state;
  videos.update((rows) => rows.map((video) => video.video_id === videoId
    ? { ...video, watched: state.watched, starred: state.starred, hidden: state.hidden }
    : video));
  if ((get(viewFilter) === "unread" && state.watched) ||
      (get(viewFilter) === "starred" && !state.starred) ||
      (get(viewFilter) !== "hidden" && state.hidden) ||
      (get(viewFilter) === "hidden" && !state.hidden)) {
    videos.update((rows) => rows.filter((video) => video.video_id !== videoId));
  }
  Promise.allSettled([loadFolders(), reloadCachedChannelLists()]);
  return state;
}

export async function setChannelFavorite(channelId, favorite) {
  const resp = await fetch(`${API}/api/channels/${encodeURIComponent(channelId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "Failed to update favorite");
  channelLists.update((all) => Object.fromEntries(Object.entries(all).map(([folderId, rows]) => [
    folderId,
    rows.map((channel) => channel.id === channelId ? { ...channel, favorite } : channel)
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)),
  ])));
  await loadVideos(get(activeFolder), {
    channelId: get(activeChannelId), q: get(searchQuery), view: get(viewFilter),
    favorites: get(favoritesOnly), sort: get(sortOrder),
  });
  return data.channel;
}

export async function loadChannelHealth(filter = get(healthFilter)) {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("status", filter);
  const resp = await fetch(`${API}/api/channels?${params}`);
  if (!resp.ok) throw new Error(`Failed to load channel health (${resp.status})`);
  channelHealth.set(await resp.json());
}

export async function loadQuotaStatus() {
  const resp = await fetch(`${API}/api/status/quota`);
  if (!resp.ok) throw new Error(`Failed to load quota status (${resp.status})`);
  const value = await resp.json();
  quotaStatus.set(value);
  return value;
}

export async function loadRefreshRuns(limit = 20) {
  const resp = await fetch(`${API}/api/status/refresh-runs?limit=${encodeURIComponent(limit)}`);
  if (!resp.ok) throw new Error(`Failed to load refresh history (${resp.status})`);
  const value = await resp.json();
  refreshRuns.set(value);
  return value;
}

export async function retryChannel(channelId) {
  let summary;
  let mutationError;
  try {
    const resp = await fetch(`${API}/api/channels/${encodeURIComponent(channelId)}/refresh`, {
      method: "POST",
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Channel refresh failed");
    summary = data.summary;
  } catch (err) {
    mutationError = err;
  } finally {
    // Refresh operational reports even when the retry itself fails. Ancillary
    // reload failures must not misreport a successful server-side mutation.
    await Promise.allSettled([
      loadChannelHealth(),
      loadFolders(),
      reloadCachedChannelLists(),
      loadVideos(get(activeFolder), {
        channelId: get(activeChannelId), q: get(searchQuery),
      }),
      loadQuotaStatus(),
      loadRefreshRuns(),
    ]);
  }
  if (mutationError) throw mutationError;
  return summary;
}

export async function deleteChannel(channelId) {
  const resp = await fetch(`${API}/api/channels/${encodeURIComponent(channelId)}`, {
    method: "DELETE",
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "Failed to delete channel");

  if (get(activeChannelId) === channelId) activeChannelId.set(null);
  channelHealth.update((rows) => rows.filter((channel) => channel.id !== channelId));
  const results = await Promise.allSettled([
    loadFolders(),
    reloadCachedChannelLists(),
    loadChannelHealth(),
    loadVideos(get(activeFolder), {
      channelId: get(activeChannelId), q: get(searchQuery), view: get(viewFilter),
      favorites: get(favoritesOnly), sort: get(sortOrder),
    }),
  ]);
  return { ...data, reloadFailures: results.filter((result) => result.status === "rejected").length };
}

export function initializeUrlState() {
  const params = new URLSearchParams(window.location.search);
  activeFolder.set(params.get("folder") || "__all__");
  activeChannelId.set(params.get("channel"));
  searchQuery.set(params.get("q") || "");
  viewFilter.set(["all", "unread", "starred", "hidden"].includes(params.get("view")) ? params.get("view") : "all");
  favoritesOnly.set(params.get("favorites") === "1");
  density.set(["grid", "compact", "list"].includes(params.get("density")) ? params.get("density") : "grid");
  sortOrder.set(["newest", "oldest", "favorite", "returning"].includes(params.get("sort")) ? params.get("sort") : "newest");
}

let _urlSyncStarted = false;
export function startUrlSync() {
  if (_urlSyncStarted) return () => {};
  _urlSyncStarted = true;
  let applyingPop = false;
  let historyReady = false;
  let historyTimer;
  const write = () => {
    if (applyingPop) return;
    const params = new URLSearchParams();
    const values = {
      folder: get(activeFolder), channel: get(activeChannelId), q: get(searchQuery),
      view: get(viewFilter), density: get(density), sort: get(sortOrder),
    };
    if (values.folder && values.folder !== "__all__") params.set("folder", values.folder);
    if (values.channel) params.set("channel", values.channel);
    if (values.q) params.set("q", values.q);
    if (values.view !== "all") params.set("view", values.view);
    if (get(favoritesOnly)) params.set("favorites", "1");
    if (values.density !== "grid") params.set("density", values.density);
    if (values.sort !== "newest") params.set("sort", values.sort);
    const query = params.toString();
    const next = `${location.pathname}${query ? `?${query}` : ""}`;
    clearTimeout(historyTimer);
    historyTimer = undefined;
    if (`${location.pathname}${location.search}` === next) { historyReady = true; return; }
    historyTimer = setTimeout(() => {
      if (applyingPop) return;
      history[historyReady ? "pushState" : "replaceState"]({}, "", next);
      historyReady = true;
    }, historyReady ? 250 : 0);
  };
  const stores = [activeFolder, activeChannelId, searchQuery, viewFilter, favoritesOnly, density, sortOrder];
  const unsubs = stores.map((store) => store.subscribe(write));
  const pop = () => {
    clearTimeout(historyTimer);
    historyTimer = undefined;
    applyingPop = true;
    initializeUrlState();
    queueMicrotask(() => { applyingPop = false; });
  };
  window.addEventListener("popstate", pop);
  return () => { clearTimeout(historyTimer); unsubs.forEach((fn) => fn()); window.removeEventListener("popstate", pop); _urlSyncStarted = false; };
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

    await Promise.all([loadFolders(), reloadCachedChannelLists(), loadVideos(folder, {
      channelId: get(activeChannelId) || null,
      q: get(searchQuery) || null,
      view: get(viewFilter),
      favorites: get(favoritesOnly),
      sort: get(sortOrder),
    })]);
    await Promise.allSettled([loadQuotaStatus(), loadRefreshRuns()]);
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
