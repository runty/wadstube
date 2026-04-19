const fs = require("fs");
const path = require("path");
const { migrate } = require("./migrate");

const MAX_FOLDER_DEPTH = 4;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

// Recursively coerce a (possibly user-supplied) folder tree into the shape
// the rest of the server expects: every folder has channels[] + children[],
// names are strings, channel ids look like YouTube channel ids, and
// dangerous prototype keys are dropped. Anything malformed is ignored
// rather than crashed on.
function normalizeFolders(input, depth = 0) {
  if (!Array.isArray(input) || depth > MAX_FOLDER_DEPTH) return [];
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const name = typeof raw.name === "string" ? raw.name : null;
    if (!name) continue;
    const id = typeof raw.id === "string" ? raw.id : slugify(name);
    const channels = [];
    if (Array.isArray(raw.channels)) {
      for (const ch of raw.channels) {
        if (!ch || typeof ch !== "object") continue;
        const chId = typeof ch.id === "string" ? ch.id : null;
        if (!chId || !CHANNEL_ID_RE.test(chId)) continue;
        const entry = {
          id: chId,
          name: typeof ch.name === "string" ? ch.name : "Unknown",
          addedAt: typeof ch.addedAt === "string" ? ch.addedAt : new Date().toISOString(),
        };
        if (ch.userRenamed === true) entry.userRenamed = true;
        channels.push(entry);
      }
    }
    out.push({
      id,
      name,
      channels,
      children: normalizeFolders(raw.children, depth + 1),
    });
  }
  return out;
}

// Top-level shape check + normalization for either an on-disk tube.json or
// an uploaded restore payload.
function normalizeTubeData(input) {
  if (!input || typeof input !== "object") {
    return { version: 1, folders: [] };
  }
  return {
    version: typeof input.version === "number" ? input.version : 1,
    folders: normalizeFolders(input.folders),
  };
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
      return normalizeTubeData(JSON.parse(fs.readFileSync(tubePath, "utf-8")));
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

function findFolder(folders, name) {
  for (const f of folders) {
    if (f.name === name || f.id === name) return f;
    for (const child of f.children || []) {
      if (child.name === name || child.id === name) return child;
    }
  }
  return null;
}

function findFolderParent(folders, name) {
  for (const f of folders) {
    for (const child of f.children || []) {
      if (child.name === name || child.id === name) return f;
    }
  }
  return null;
}

function collectAllChannelIds(folder) {
  const ids = (folder.channels || []).map((ch) => ch.id);
  for (const child of folder.children || []) {
    ids.push(...collectAllChannelIds(child));
  }
  return ids;
}

function getChannelsForFolder(data, folderName) {
  const folder = findFolder(data.folders, folderName);
  if (!folder) return [];
  return collectAllChannelIds(folder);
}

function getFolderTreeSummary(data) {
  return data.folders.map((f) => ({
    name: f.name,
    channelCount: collectAllChannelIds(f).length,
    children: (f.children || []).map((child) => ({
      name: child.name,
      channelCount: child.channels.length,
    })),
  }));
}

// --- Mutation functions ---

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function createFolder(data, name, parentName) {
  if (findFolder(data.folders, name)) {
    throw new Error(`Folder "${name}" already exists`);
  }

  const folder = {
    id: slugify(name),
    name,
    channels: [],
    children: [],
  };

  if (parentName) {
    const parent = findFolder(data.folders, parentName);
    if (!parent) throw new Error(`Parent folder "${parentName}" not found`);
    parent.children.push(folder);
  } else {
    data.folders.push(folder);
    // Keep sorted
    data.folders.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
}

function renameFolder(data, oldName, newName) {
  const folder = findFolder(data.folders, oldName);
  if (!folder) throw new Error(`Folder "${oldName}" not found`);
  if (findFolder(data.folders, newName)) {
    throw new Error(`Folder "${newName}" already exists`);
  }

  folder.name = newName;
  folder.id = slugify(newName);

  // Re-sort top-level if it's a top-level folder
  if (data.folders.includes(folder)) {
    data.folders.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
}

function deleteFolder(data, name) {
  // Check top-level
  const idx = data.folders.findIndex((f) => f.name === name || f.id === name);
  if (idx !== -1) {
    data.folders.splice(idx, 1);
    return;
  }

  // Check children
  for (const parent of data.folders) {
    const childIdx = (parent.children || []).findIndex((c) => c.name === name || c.id === name);
    if (childIdx !== -1) {
      parent.children.splice(childIdx, 1);
      return;
    }
  }

  throw new Error(`Folder "${name}" not found`);
}

function addChannel(data, folderName, channelId, channelName) {
  const folder = findFolder(data.folders, folderName);
  if (!folder) throw new Error(`Folder "${folderName}" not found`);

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
  if (sourceFolderName === destFolderName) return;

  const source = findFolder(data.folders, sourceFolderName);
  if (!source) throw new Error(`Source folder "${sourceFolderName}" not found`);
  const dest = findFolder(data.folders, destFolderName);
  if (!dest) throw new Error(`Destination folder "${destFolderName}" not found`);

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
      // Skip channels the user has renamed in the sidebar — their choice
      // should stick even if YouTube's display title changes.
      if (ch.userRenamed) continue;
      const newName = channelIdToName[ch.id];
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
    for (const ch of folder.channels || []) ids.add(ch.id);
    for (const child of folder.children || []) walk(child);
  }
  for (const folder of data.folders || []) walk(folder);
  return ids;
}

module.exports = {
  loadData,
  saveData,
  findFolder,
  collectAllChannelIds,
  getChannelsForFolder,
  getFolderTreeSummary,
  createFolder,
  renameFolder,
  deleteFolder,
  addChannel,
  removeChannel,
  getChannelList,
  syncChannelNames,
  renameChannel,
  moveChannel,
  normalizeTubeData,
  allReferencedChannelIds,
};
