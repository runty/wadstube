import { writable } from "svelte/store";

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

const API = "";

export async function loadFolders() {
  const resp = await fetch(`${API}/api/folders`);
  folders.set(await resp.json());
}

export async function loadVideos(folder) {
  const param = folder && folder !== "__all__" ? `?folder=${encodeURIComponent(folder)}` : "";
  const resp = await fetch(`${API}/api/videos${param}`);
  videos.set(await resp.json());
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
  try {
    const url =
      folder && folder !== "__all__"
        ? `${API}/api/refresh/${encodeURIComponent(folder)}`
        : `${API}/api/refresh`;

    const resp = await fetch(url, { method: "POST" });
    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || `Refresh failed (${resp.status})`);
    }

    // Reload videos for current view
    await loadVideos(folder);
    return data;
  } catch (err) {
    error.set(err.message || "Something went wrong");
    throw err;
  } finally {
    refreshing.set(false);
  }
}
