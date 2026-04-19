require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express = require("express");
const cors = require("cors");
const path = require("path");
const { loadData, getFolderTreeSummary, syncChannelNames, saveData, collectAllChannelIds } =
  require("./lib/data");
const { resolveUrl } = require("./lib/youtube");
const Db = require("./lib/db");
const { migrateCacheJsonIfNeeded } = require("./lib/migrate-cache");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "wadstube.db");
const MAX_VIDEOS = parseInt(process.env.MAX_VIDEOS || "50", 10);
const REFRESH_INTERVAL_MINUTES = parseInt(
  process.env.REFRESH_INTERVAL_MINUTES || "30",
  10,
);
const REFRESH_MODE = (process.env.REFRESH_MODE || "rss").toLowerCase();
const API_KEY = process.env.YOUTUBE_API_KEY;

if (!["rss", "api"].includes(REFRESH_MODE)) {
  console.error(`Invalid REFRESH_MODE "${REFRESH_MODE}" — use "rss" or "api"`);
  process.exit(1);
}

if (!API_KEY) {
  console.error("YOUTUBE_API_KEY is required in .env");
  process.exit(1);
}

const data = loadData(DATA_DIR);
const db = new Db(DB_FILE);
migrateCacheJsonIfNeeded(db, DATA_DIR);

const appState = {
  data,
  dataDir: DATA_DIR,
  db,
  apiKey: API_KEY,
  maxVideos: MAX_VIDEOS,
  refreshMode: REFRESH_MODE,
  refreshLock: null,
};

console.log(`Refresh mode: ${REFRESH_MODE}`);

// Sync channel names from DB into tube.json (no network calls)
const initialNameUpdates = syncChannelNames(data, db.getChannelNames());
if (initialNameUpdates > 0) {
  saveData(DATA_DIR, data);
  console.log(`Synced ${initialNameUpdates} channel name(s) from db`);
}

const summary = getFolderTreeSummary(data);
console.log(`${summary.length} top-level folders`);
const stats = db.getStats();
console.log(`DB: ${stats.channelCount} channels, ${stats.videoCount} videos`);

// Nightly backups (GFS retention: 4 daily + 4 weekly + 4 monthly)
const { scheduleBackups } = require("./lib/backup");
scheduleBackups(DATA_DIR, db);

// Background RSS poller (opt-out with REFRESH_INTERVAL_MINUTES=0)
const { startPoller } = require("./lib/poller");
startPoller(appState, {
  intervalMinutes: REFRESH_INTERVAL_MINUTES,
  collectAllChannelIds,
  syncChannelNames,
  saveData,
});

// Express app
const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/folders", require("./routes/folders")(appState));
app.use("/api/videos", require("./routes/videos")(appState));
app.use("/api/refresh", require("./routes/refresh")(appState));

// Backup — download tube.json
app.get("/api/backup", (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  res.setHeader("Content-Disposition", `attachment; filename="tube-backup-${timestamp}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.json(appState.data);
});

// Restore — upload tube.json
app.post("/api/restore", (req, res) => {
  try {
    const uploaded = req.body;
    if (!uploaded || !uploaded.version || !Array.isArray(uploaded.folders)) {
      return res.status(400).json({ error: "Invalid backup file. Must be a tube.json with version and folders." });
    }

    const fs = require("fs");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = path.join(DATA_DIR, `tube-pre-restore-${timestamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(appState.data, null, 2), "utf-8");
    console.log(`Saved pre-restore backup to ${backupPath}`);

    appState.data = uploaded;
    saveData(DATA_DIR, appState.data);

    res.json({ ok: true, folders: getFolderTreeSummary(appState.data) });
  } catch (err) {
    console.error("Restore error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Resolve URL endpoint
app.post("/api/resolve-url", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });
    const result = await resolveUrl(API_KEY, url);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Serve Svelte frontend
const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
