require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express = require("express");
const cors = require("cors");
const path = require("path");
const { loadData, getFolderTreeSummary } = require("./lib/data");
const { resolveUrl } = require("./lib/youtube");
const Cache = require("./lib/cache");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
const MAX_VIDEOS = parseInt(process.env.MAX_VIDEOS || "15", 10);
const API_KEY = process.env.YOUTUBE_API_KEY;

if (!API_KEY) {
  console.error("YOUTUBE_API_KEY is required in .env");
  process.exit(1);
}

// Load data (auto-migrates from PocketTube format if needed)
const data = loadData(DATA_DIR);
const cache = new Cache(CACHE_FILE);

const appState = {
  data,
  dataDir: DATA_DIR,
  cache,
  apiKey: API_KEY,
  maxVideos: MAX_VIDEOS,
};

const summary = getFolderTreeSummary(data);
console.log(`${summary.length} top-level folders`);
const stats = cache.getStats();
console.log(`Cache: ${stats.channelCount} channels, ${stats.videoCount} videos`);

// Express app
const app = express();
app.use(cors());
app.use(express.json());

// API routes
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

    // Save backup of current data before overwriting
    const { saveData } = require("./lib/data");
    const fs = require("fs");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = path.join(DATA_DIR, `tube-pre-restore-${timestamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(appState.data, null, 2), "utf-8");
    console.log(`Saved pre-restore backup to ${backupPath}`);

    // Replace data
    appState.data = uploaded;
    saveData(DATA_DIR, appState.data);

    const { getFolderTreeSummary } = require("./lib/data");
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
