const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

const SKIP_KEYS = new Set([
  "ysc_collection", "ysc_meta", "ysc_popup", "ysc_settings", "ysc_statistics",
]);

function migrate(dataDir) {
  // Find PocketTube JSON
  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith("youtube_subscription_manager_") && f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No PocketTube JSON found in ${dataDir}`);
  }

  const ptPath = path.join(dataDir, files[files.length - 1]);
  console.log(`Migrating from: ${ptPath}`);
  let ptData;
  try {
    ptData = JSON.parse(fs.readFileSync(ptPath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse PocketTube JSON (${ptPath}): ${err.message}`);
  }

  // Load cache for channel name enrichment
  const cachePath = path.join(dataDir, "cache.json");
  const channelNames = new Map();
  if (fs.existsSync(cachePath)) {
    try {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      for (const [cid, entry] of Object.entries(cache.channels || {})) {
        const name = entry.videos?.[0]?.channel;
        if (name) channelNames.set(cid, name);
      }
      console.log(`Loaded ${channelNames.size} channel names from cache`);
    } catch {
      console.log("Could not read cache for enrichment");
    }
  }

  const settings = ptData.ysc_settings || {};
  const subGroups = settings.sub_groups || {};
  const now = new Date().toISOString();

  // Collect all child folder names
  const childrenSet = new Set();
  for (const children of Object.values(subGroups)) {
    for (const child of Object.keys(children)) {
      childrenSet.add(child);
    }
  }

  function convertChannels(channelIds) {
    return channelIds.map((cid) => {
      if (typeof cid !== "string" || !cid.trim()) {
        throw new Error("PocketTube export contains a malformed channel reference");
      }
      const channel = {
        id: cid,
        name: channelNames.get(cid) || "Unknown",
        addedAt: now,
      };
      if (!CHANNEL_ID_RE.test(cid)) {
        channel.unresolved = true;
      }
      return channel;
    });
  }

  function buildFolder(name) {
    const channelIds = ptData[name] || [];
    return {
      id: `folder-${crypto.randomUUID()}`,
      name,
      channels: convertChannels(channelIds),
      children: [],
    };
  }

  // Collect valid folder names
  const folderNames = [];
  for (const [name, value] of Object.entries(ptData)) {
    if (!SKIP_KEYS.has(name) && Array.isArray(value)) {
      folderNames.push(name);
    }
  }

  // Build tree
  const folders = [];
  for (const name of folderNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    if (childrenSet.has(name)) continue;

    const folder = buildFolder(name);

    if (subGroups[name]) {
      for (const childName of Object.keys(subGroups[name]).sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase())
      )) {
        if (ptData[childName] && Array.isArray(ptData[childName])) {
          folder.children.push(buildFolder(childName));
        }
      }
    }

    folders.push(folder);
  }

  const tubeData = { version: 1, folders };

  // Stats
  let totalChannels = 0;
  let namedChannels = 0;
  function countChannels(f) {
    for (const ch of f.channels) {
      totalChannels++;
      if (ch.name !== "Unknown") namedChannels++;
    }
    for (const child of f.children) countChannels(child);
  }
  folders.forEach(countChannels);

  console.log(`Migrated ${folders.length} top-level folders`);
  console.log(`${totalChannels} total channels, ${namedChannels} with names (${totalChannels - namedChannels} unknown)`);

  // Write
  const outPath = path.join(dataDir, "tube.json");
  fs.writeFileSync(outPath, JSON.stringify(tubeData, null, 2), "utf-8");
  console.log(`Wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);

  return tubeData;
}

module.exports = { migrate };
