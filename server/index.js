require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express = require("express");
const path = require("path");
const { loadData, getFolderTreeSummary, syncChannelNames, saveData,
  allReferencedChannelIds } =
  require("./lib/data");
const { resolveUrl, httpStatusForYoutubeError } = require("./lib/youtube");
const { restoreData } = require("./lib/restore");
const { securityHeaders, corsOriginPolicy, rateLimit, postOnly } = require("./lib/security");
const Db = require("./lib/db");
const { migrateCacheJsonIfNeeded } = require("./lib/migrate-cache");
const { loadPolicy } = require("./lib/refresh-policy");
const { loadSmartRefreshPolicy } = require("./lib/settings");
const { QuotaLedger, parseLimits } = require("./lib/quota");
const { mountFrontend } = require("./lib/frontend");

const STARTED_AT = new Date().toISOString();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "wadstube.db");
const MAX_VIDEOS = parseInt(process.env.MAX_VIDEOS || "50", 10);
const REFRESH_MODE = (process.env.REFRESH_MODE || "rss").toLowerCase();
const REFRESH_MODE_MANUAL = (process.env.REFRESH_MODE_MANUAL || REFRESH_MODE).toLowerCase();
const API_KEY = process.env.YOUTUBE_API_KEY;
let DEFAULT_SMART_REFRESH_POLICY;
let QUOTA_LIMITS;
try {
  DEFAULT_SMART_REFRESH_POLICY = loadPolicy();
  QUOTA_LIMITS = parseLimits();
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

for (const [name, val] of [["REFRESH_MODE_MANUAL", REFRESH_MODE_MANUAL]]) {
  if (!["rss", "api"].includes(val)) {
    console.error(`Invalid ${name} "${val}" — use "rss" or "api"`);
    process.exit(1);
  }
}

if (!API_KEY && REFRESH_MODE_MANUAL === "api") {
  console.error("YOUTUBE_API_KEY is required when a refresh mode is api");
  process.exit(1);
}

const data = loadData(DATA_DIR);
const db = new Db(DB_FILE);
migrateCacheJsonIfNeeded(db, DATA_DIR);
const storedSmartRefresh = loadSmartRefreshPolicy(db, DEFAULT_SMART_REFRESH_POLICY);
const purgedStartupOrphans = db.purgeOrphanChannels(allReferencedChannelIds(data));
if (purgedStartupOrphans) {
  console.warn(`[startup] purged ${purgedStartupOrphans} orphaned or unresolved DB channel row(s)`);
}
const abandonedRuns = db.markAbandonedRefreshRuns();
if (abandonedRuns) console.warn(`[startup] marked ${abandonedRuns} interrupted refresh run(s) abandoned`);
db.pruneRefreshRuns();
const quota = new QuotaLedger(db, { limits: QUOTA_LIMITS });

const appState = {
  data,
  dataDir: DATA_DIR,
  db,
  apiKey: API_KEY,
  maxVideos: MAX_VIDEOS,
  startedAt: STARTED_AT,
  defaultMode: REFRESH_MODE,
  manualMode: REFRESH_MODE_MANUAL,
  refreshLock: null,
  defaultSmartPolicy: DEFAULT_SMART_REFRESH_POLICY,
  smartPolicy: storedSmartRefresh.policy,
  smartPolicySource: storedSmartRefresh.source,
  refreshIntervalMinutes: 0,
  quota,
  activeTasks: new Set(),
};

console.log(`Refresh mode — manual only: ${REFRESH_MODE_MANUAL}`);

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
const backupController = scheduleBackups(DATA_DIR, db, appState);
appState.backupController = backupController;

// Express app
const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) {
  const value = /^\d+$/.test(process.env.TRUST_PROXY)
    ? Number(process.env.TRUST_PROXY)
    : process.env.TRUST_PROXY;
  app.set("trust proxy", value);
}
app.use(securityHeaders);
// 5 MB is comfortably larger than a realistic tube.json (a 2,400-channel
// backup is ~300 KB). The default 100 KB silently rejects real restores.
app.use(express.json({ limit: "5mb" }));
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
app.use(
  "/api",
  corsOriginPolicy(allowedOrigins, process.env.PUBLIC_ORIGIN || null),
);
app.use(
  "/api",
  rateLimit({ windowMs: 60_000, max: 180, name: "API" }),
);
app.use(
  "/api/refresh",
  postOnly(rateLimit({ windowMs: 60_000, max: 10, name: "refresh" })),
);
app.use(
  "/api/resolve-url",
  rateLimit({ windowMs: 60_000, max: 30, name: "URL resolution" }),
);
app.use(
  "/api/restore",
  rateLimit({ windowMs: 60 * 60_000, max: 5, name: "restore" }),
);

app.use("/api/folders", require("./routes/folders")(appState));
app.use("/api/videos", require("./routes/videos")(appState));
app.use("/api/channels", require("./routes/channels")(appState));
app.use("/api/refresh", require("./routes/refresh")(appState));
app.use("/api/status", require("./routes/status")(appState));
app.use("/api/settings", require("./routes/settings")(appState));

// Backup — download tube.json
app.get("/api/backup", (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  res.setHeader("Content-Disposition", `attachment; filename="tube-backup-${timestamp}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.json(appState.data);
});

// Full export — includes subscriptions plus an integrity-checked consistent
// SQLite snapshot. Restore remains a controlled offline operation so a bad
// upload can never replace the live DB.
app.get("/api/full-backup", async (_req, res) => {
  const { createFullBackup } = require("./lib/full-backup");
  let task;
  task = (async () => {
    let backup;
    try {
      backup = await createFullBackup(DATA_DIR, db, appState);
      await new Promise((resolve) => {
        res.download(backup.filePath, backup.filename, (err) => {
          backup.cleanup();
          if (err && !res.headersSent) res.status(500).json({ error: err.message });
          resolve();
        });
      });
    } catch (err) {
      backup?.cleanup?.();
      if (!res.headersSent) res.status(500).json({ error: `Full backup failed: ${err.message}` });
    }
  })();
  appState.activeTasks.add(task);
  try { await task; }
  finally { appState.activeTasks.delete(task); }
});

// Restore — upload tube.json
app.post("/api/restore", async (req, res) => {
  try {
    const uploaded = req.body;
    if (!uploaded || typeof uploaded !== "object" || !Array.isArray(uploaded.folders)) {
      return res.status(400).json({ error: "Invalid backup file. Must be a tube.json with a folders array." });
    }

    const result = await restoreData(appState, uploaded);

    res.json({
      ok: true,
      folders: getFolderTreeSummary(appState.data),
      purgedChannels: result.purgedChannels,
      normalizationRepairs: result.normalizationRepairs,
      recoverySnapshot: result.snapshotName,
    });
  } catch (err) {
    console.error("Restore error:", err);
    res.status(err.status || 500).json({
      error: err.message,
      details: err.details,
      recoverySnapshot: err.restoreSnapshot,
    });
  }
});

// Resolve URL endpoint
app.post("/api/resolve-url", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });
    const result = await resolveUrl(API_KEY, url, { quota });
    res.json(result);
  } catch (err) {
    res.status(httpStatusForYoutubeError(err, 400)).json({ error: err.message });
  }
});

// Serve Svelte frontend
const clientDist = path.join(__dirname, "..", "client", "dist");
mountFrontend(app, clientDist);

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}; stopping schedulers and draining refresh work`);
  backupController?.stop();
  const closePromise = new Promise((resolve) => server.close(resolve));
  const { waitForRefreshDrain, waitForTasksDrain } = require("./lib/shutdown");
  const drained = await waitForRefreshDrain(appState, 20_000);
  const tasksDrained = await waitForTasksDrain(appState.activeTasks, 20_000);
  if (!drained) {
    console.warn("[shutdown] refresh drain timed out; closing active connections");
    server.closeAllConnections?.();
  }
  if (!tasksDrained) console.warn("[shutdown] backup/export drain timed out");
  await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  db.close();
  process.exit(drained && tasksDrained ? 0 : 1);
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
