const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { migrate } = require("./migrate");

const MAX_FOLDER_DEPTH = 4;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

// Recursively coerce a (possibly user-supplied) folder tree into the shape
// the rest of the server expects: every folder has channels[] + children[],
// names are strings, resolved channel ids look like YouTube channel ids,
// legacy nonempty references are quarantined, and dangerous prototype keys
// are dropped. A detailed report lets restores reject lossy input while
// startup repairs can be persisted and audited.
function newFolderId() {
  return `folder-${crypto.randomUUID()}`;
}

function normalizeFolders(input, depth, state, location) {
  if (depth > MAX_FOLDER_DEPTH) {
    if (Array.isArray(input) && input.length) {
      state.losses.push(`${location}: folders beyond maximum depth were dropped`);
    }
    return [];
  }
  if (!Array.isArray(input)) {
    if (input !== undefined) {
      state.losses.push(`${location}: expected an array`);
    } else {
      state.repairs.push(`${location}: added missing array`);
    }
    return [];
  }
  const out = [];
  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    const itemLocation = `${location}[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      state.losses.push(`${itemLocation}: invalid folder was dropped`);
      continue;
    }
    const name = typeof raw.name === "string" ? raw.name : null;
    if (!name) {
      state.losses.push(`${itemLocation}: folder without a name was dropped`);
      continue;
    }
    let id =
      typeof raw.id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.id)
        ? raw.id
        : newFolderId();
    if (id !== raw.id) {
      state.repairs.push(`${itemLocation}: generated a stable folder ID`);
    }
    if (state.ids.has(id)) {
      id = newFolderId();
      state.repairs.push(`${itemLocation}: replaced a duplicate folder ID`);
    }
    state.ids.add(id);
    const channels = [];
    if (Array.isArray(raw.channels)) {
      for (let channelIndex = 0; channelIndex < raw.channels.length; channelIndex++) {
        const ch = raw.channels[channelIndex];
        const channelLocation = `${itemLocation}.channels[${channelIndex}]`;
        if (!ch || typeof ch !== "object" || Array.isArray(ch)) {
          state.losses.push(`${channelLocation}: invalid channel was dropped`);
          continue;
        }
        const chId = typeof ch.id === "string" ? ch.id : null;
        if (!chId || !chId.trim()) {
          state.losses.push(`${channelLocation}: invalid channel ID was dropped`);
          continue;
        }
        const entry = {
          id: chId,
          name: typeof ch.name === "string" ? ch.name : "Unknown",
          addedAt: typeof ch.addedAt === "string" ? ch.addedAt : new Date().toISOString(),
        };
        if (typeof ch.name !== "string") {
          state.repairs.push(`${channelLocation}: supplied a missing channel name`);
        }
        if (typeof ch.addedAt !== "string") {
          state.repairs.push(`${channelLocation}: supplied a missing addedAt timestamp`);
        }
        // Older PocketTube exports sometimes stored a YouTube URL (or another
        // non-UC reference) in the id field. Keep that subscription in its
        // original folder, but quarantine it from every network/DB path until
        // the user removes or replaces it with a resolved channel.
        if (!CHANNEL_ID_RE.test(chId)) {
          entry.unresolved = true;
          if (ch.unresolved !== true) {
            state.repairs.push(`${channelLocation}: preserved unresolved legacy channel reference`);
          }
        }
        if (ch.userRenamed === true) entry.userRenamed = true;
        channels.push(entry);
      }
    } else if (raw.channels === undefined) {
      state.repairs.push(`${itemLocation}.channels: added missing array`);
    } else {
      state.losses.push(`${itemLocation}.channels: expected an array`);
    }
    out.push({
      id,
      name,
      channels,
      children: normalizeFolders(
        raw.children,
        depth + 1,
        state,
        `${itemLocation}.children`,
      ),
    });
  }
  return out;
}

// Top-level shape check + normalization for either an on-disk tube.json or
// an uploaded restore payload.
function normalizeTubeDataDetailed(input) {
  const state = { ids: new Set(), repairs: [], losses: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    state.losses.push("root: expected an object");
    return {
      data: { version: 1, folders: [] },
      report: { repairs: state.repairs, losses: state.losses },
    };
  }
  const data = {
    version: typeof input.version === "number" ? input.version : 1,
    folders: normalizeFolders(input.folders, 0, state, "folders"),
  };
  if (typeof input.version !== "number") {
    state.repairs.push("version: supplied default version 1");
  }
  return {
    data,
    report: { repairs: state.repairs, losses: state.losses },
  };
}

function normalizeTubeData(input) {
  return normalizeTubeDataDetailed(input).data;
}

function loadData(dataDir) {
  // Ensure the data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const tubePath = path.join(dataDir, "tube.json");

  if (fs.existsSync(tubePath)) {
    console.log(`Loading data from: ${tubePath}`);
    try {
      const rawText = fs.readFileSync(tubePath, "utf-8");
      const raw = JSON.parse(rawText);
      const normalized = normalizeTubeDataDetailed(raw);
      const normalizedText = JSON.stringify(normalized.data, null, 2);
      if (normalizedText !== JSON.stringify(raw, null, 2)) {
        const backup = tubePath + ".pre-normalize." + Date.now();
        fs.copyFileSync(tubePath, backup);
        saveData(dataDir, normalized.data);
        console.log(
          `Persisted tube.json normalization (${normalized.report.repairs.length} repair(s), ` +
            `${normalized.report.losses.length} loss warning(s)); original saved to ${backup}`,
        );
      }
      return normalized.data;
    } catch (err) {
      console.error(`Failed to parse ${tubePath}: ${err.message}`);
      const backup = tubePath + ".corrupt." + Date.now();
      fs.renameSync(tubePath, backup);
      console.error(`Moved corrupt file to ${backup}, re-migrating...`);
    }
  }

  // Check for PocketTube JSON to migrate
  const pocketTubeFiles = fs.readdirSync(dataDir)
    .filter((f) => f.startsWith("youtube_subscription_manager_") && f.endsWith(".json"));

  if (pocketTubeFiles.length > 0) {
    console.log("tube.json not found, migrating from PocketTube format...");
    return migrate(dataDir);
  }

  // Fresh install — start empty
  console.log("Starting with empty data (no tube.json or PocketTube JSON found)");
  const emptyData = { version: 1, folders: [] };
  fs.writeFileSync(tubePath, JSON.stringify(emptyData, null, 2), "utf-8");
  return emptyData;
}

function saveData(dataDir, data) {
  const tubePath = path.join(dataDir, "tube.json");
  const tmpPath = tubePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, tubePath);
  } catch (err) {
    console.error(`Data save failed: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// --- Query functions ---

function walkFolders(folders, visit, parent = null, depth = 0) {
  for (const folder of folders || []) {
    const result = visit(folder, parent, depth);
    if (result !== undefined) return result;
    const childResult = walkFolders(folder.children, visit, folder, depth + 1);
    if (childResult !== undefined) return childResult;
  }
  return undefined;
}

// IDs are authoritative. The name lookup remains for compatibility with old
// clients and backup URLs, but new folder IDs never change when renamed.
function resolveFolderIdentifier(folders, identifier) {
  const byId = walkFolders(folders, (folder) =>
    folder.id === identifier ? folder : undefined,
  );
  if (byId) return { folder: byId, matchedBy: "id" };
  const matches = [];
  walkFolders(folders, (folder) => {
    if (folder.name === identifier) matches.push(folder);
    return undefined;
  });
  if (matches.length === 1) return { folder: matches[0], matchedBy: "name" };
  if (matches.length > 1) return { folder: null, matchedBy: "ambiguous-name" };
  return null;
}

function findFolder(folders, identifier) {
  return resolveFolderIdentifier(folders, identifier)?.folder || null;
}

function resolveFolderRouteId(data, identifier) {
  const resolved = resolveFolderIdentifier(data.folders, identifier);
  if (!resolved) throw new Error(`Folder "${identifier}" not found`);
  if (resolved.matchedBy === "ambiguous-name") {
    throw new Error(`Folder name "${identifier}" is ambiguous; use its immutable ID`);
  }
  return { id: resolved.folder.id, legacyName: resolved.matchedBy === "name" };
}

function findFolderByName(folders, name, excluding = null) {
  return (
    walkFolders(folders, (folder) =>
      folder !== excluding && folder.name === name ? folder : undefined,
    ) || null
  );
}

function findFolderParent(folders, identifier) {
  const target = findFolder(folders, identifier);
  if (!target) return null;
  return (
    walkFolders(folders, (folder, parent) =>
      folder === target ? parent : undefined,
    ) || null
  );
}

function findFolderDepth(folders, identifier) {
  const target = findFolder(folders, identifier);
  if (!target) return null;
  return walkFolders(folders, (folder, _parent, depth) =>
    folder === target ? depth : undefined,
  );
}

function collectAllChannelIds(folder) {
  const ids = (folder.channels || [])
    .filter((ch) => isResolvedChannel(ch))
    .map((ch) => ch.id);
  for (const child of folder.children || []) {
    ids.push(...collectAllChannelIds(child));
  }
  return ids;
}

function collectAllChannels(folder) {
  const channels = [...(folder.channels || [])];
  for (const child of folder.children || []) {
    channels.push(...collectAllChannels(child));
  }
  return channels;
}

function isResolvedChannel(channel) {
  return !!channel && channel.unresolved !== true &&
    typeof channel.id === "string" && CHANNEL_ID_RE.test(channel.id);
}

function getChannelsForFolder(data, folderName) {
  const folder = findFolder(data.folders, folderName);
  if (!folder) return [];
  return collectAllChannelIds(folder);
}

function getFolderTreeSummary(data) {
  function summarize(folder) {
    const channels = collectAllChannels(folder);
    return {
      id: folder.id,
      name: folder.name,
      channelCount: channels.length,
      unresolvedCount: channels.filter((channel) => !isResolvedChannel(channel)).length,
      children: (folder.children || []).map(summarize),
    };
  }
  return data.folders.map(summarize);
}

// --- Mutation functions ---

function createFolder(data, name, parentName) {
  if (findFolderByName(data.folders, name)) {
    throw new Error(`Folder "${name}" already exists`);
  }

  const folder = {
    id: newFolderId(),
    name,
    channels: [],
    children: [],
  };

  if (parentName) {
    const parent = findFolder(data.folders, parentName);
    if (!parent) throw new Error(`Parent folder "${parentName}" not found`);
    const parentDepth = findFolderDepth(data.folders, parentName);
    if (parentDepth >= MAX_FOLDER_DEPTH) {
      throw new Error(`Folder nesting is limited to ${MAX_FOLDER_DEPTH + 1} levels`);
    }
    parent.children.push(folder);
    parent.children.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  } else {
    data.folders.push(folder);
    // Keep sorted
    data.folders.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
}

function renameFolder(data, oldName, newName) {
  const folder = findFolder(data.folders, oldName);
  if (!folder) throw new Error(`Folder "${oldName}" not found`);
  if (findFolderByName(data.folders, newName, folder)) {
    throw new Error(`Folder "${newName}" already exists`);
  }

  folder.name = newName;
  const parent = findFolderParent(data.folders, folder.id);
  const siblings = parent ? parent.children : data.folders;
  siblings.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

function deleteFolder(data, name) {
  const folder = findFolder(data.folders, name);
  if (!folder) throw new Error(`Folder "${name}" not found`);
  const parent = findFolderParent(data.folders, folder.id);
  const siblings = parent ? parent.children : data.folders;
  const index = siblings.indexOf(folder);
  if (index === -1) throw new Error(`Folder "${name}" not found`);
  siblings.splice(index, 1);
}

function addChannel(data, folderName, channelId, channelName) {
  const folder = findFolder(data.folders, folderName);
  if (!folder) throw new Error(`Folder "${folderName}" not found`);
  if (typeof channelId !== "string" || !CHANNEL_ID_RE.test(channelId)) {
    throw new Error("Invalid YouTube channel ID");
  }

  if (folder.channels.some((ch) => ch.id === channelId)) {
    return; // already exists
  }

  folder.channels.push({
    id: channelId,
    name: channelName || "Unknown",
    addedAt: new Date().toISOString(),
  });
}

function removeChannel(data, folderName, channelId) {
  const folder = findFolder(data.folders, folderName);
  if (!folder) throw new Error(`Folder "${folderName}" not found`);
  folder.channels = folder.channels.filter((ch) => ch.id !== channelId);
}

// Remove every membership for a channel, including memberships nested in
// child folders. Channel health is global rather than folder-scoped, so its
// delete action uses this instead of requiring the user to find each copy.
function removeChannelEverywhere(data, channelId) {
  let removed = 0;
  function walk(folders) {
    for (const folder of folders || []) {
      const before = folder.channels.length;
      folder.channels = folder.channels.filter((channel) => channel.id !== channelId);
      removed += before - folder.channels.length;
      walk(folder.children);
    }
  }
  walk(data.folders);
  return removed;
}

function getChannelList(data, folderName) {
  const folder = findFolder(data.folders, folderName);
  if (!folder) throw new Error(`Folder "${folderName}" not found`);
  return [...folder.channels].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function renameChannel(data, folderName, channelId, newName) {
  const folder = findFolder(data.folders, folderName);
  if (!folder) throw new Error(`Folder "${folderName}" not found`);
  const channel = folder.channels.find((ch) => ch.id === channelId);
  if (!channel) throw new Error(`Channel "${channelId}" not found in "${folderName}"`);
  channel.name = newName;
  // Pin the name so syncChannelNames doesn't revert it later.
  channel.userRenamed = true;
}

function moveChannel(data, sourceFolderName, channelId, destFolderName) {
  const source = findFolder(data.folders, sourceFolderName);
  if (!source) throw new Error(`Source folder "${sourceFolderName}" not found`);
  const dest = findFolder(data.folders, destFolderName);
  if (!dest) throw new Error(`Destination folder "${destFolderName}" not found`);
  if (source === dest) return;

  const idx = source.channels.findIndex((ch) => ch.id === channelId);
  if (idx === -1) throw new Error(`Channel "${channelId}" not found in "${sourceFolderName}"`);

  // Don't duplicate if already in destination
  if (dest.channels.some((ch) => ch.id === channelId)) {
    source.channels.splice(idx, 1);
    return;
  }

  const [channel] = source.channels.splice(idx, 1);
  dest.channels.push(channel);
}

// Update channel names in tube.json from a map of {channelId: latestName}.
// Returns the number of channels whose name was updated.
function syncChannelNames(data, channelIdToName) {
  let updated = 0;
  function walk(folder) {
    for (const ch of folder.channels || []) {
      if (!isResolvedChannel(ch)) continue;
      // Skip channels the user has renamed in the sidebar — their choice
      // should stick even if YouTube's display title changes.
      if (ch.userRenamed) continue;
      const newName = Object.hasOwn(channelIdToName, ch.id)
        ? channelIdToName[ch.id]
        : null;
      if (newName && newName !== ch.name) {
        ch.name = newName;
        updated++;
      }
    }
    for (const child of folder.children || []) walk(child);
  }
  for (const folder of data.folders || []) walk(folder);
  return updated;
}

// Returns the set of channel ids referenced anywhere in the folder tree.
// Used after a delete/move so we know which DB channels are now orphaned.
function allReferencedChannelIds(data) {
  const ids = new Set();
  function walk(folder) {
    for (const ch of folder.channels || []) {
      if (isResolvedChannel(ch)) ids.add(ch.id);
    }
    for (const child of folder.children || []) walk(child);
  }
  for (const folder of data.folders || []) walk(folder);
  return ids;
}

module.exports = {
  loadData,
  saveData,
  findFolder,
  resolveFolderIdentifier,
  resolveFolderRouteId,
  collectAllChannelIds,
  collectAllChannels,
  isResolvedChannel,
  getChannelsForFolder,
  getFolderTreeSummary,
  createFolder,
  renameFolder,
  deleteFolder,
  addChannel,
  removeChannel,
  removeChannelEverywhere,
  getChannelList,
  syncChannelNames,
  renameChannel,
  moveChannel,
  normalizeTubeData,
  normalizeTubeDataDetailed,
  allReferencedChannelIds,
  CHANNEL_ID_RE,
  MAX_FOLDER_DEPTH,
};
