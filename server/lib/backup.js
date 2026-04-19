const fs = require("fs");
const path = require("path");

// Format a Date as YYYY-MM-DD in local time (container TZ).
function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ISO 8601 week key (YYYY-Www), computed in local time.
function isoWeekKey(d) {
  // Clone as UTC midnight of the local date so the ISO week math is stable.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function atomicCopy(src, dest) {
  const tmp = dest + ".tmp";
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

function backupsRoot(dataDir) {
  return path.join(dataDir, "backups");
}

function ensureBackupsDir(dataDir) {
  const root = backupsRoot(dataDir);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

// List existing backup directory names (YYYY-MM-DD) sorted newest first.
function listBackups(dataDir) {
  const root = backupsRoot(dataDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

function createBackup(dataDir, db) {
  const date = localDateString();
  const root = ensureBackupsDir(dataDir);
  const destDir = path.join(root, date);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const files = ["tube.json"];
  const copied = [];
  for (const name of files) {
    const src = path.join(dataDir, name);
    if (!fs.existsSync(src)) continue;
    atomicCopy(src, path.join(destDir, name));
    copied.push(name);
  }

  if (db) {
    try {
      const dbDest = path.join(destDir, "wadstube.db");
      db.vacuumInto(dbDest);
      copied.push("wadstube.db");
    } catch (err) {
      console.error(`[backup] db snapshot failed: ${err.message}`);
    }
  }

  return { dir: destDir, files: copied };
}

// Strict GFS retention:
//   - newest 4 by date -> daily
//   - then newest in each of the next 4 ISO weeks (not already in daily)
//   - then newest in each of the next 4 months (not already in daily/weekly)
//   - delete the rest
function applyRetention(dataDir) {
  const root = backupsRoot(dataDir);
  const names = listBackups(dataDir); // newest first
  if (names.length === 0) return { kept: [], deleted: [] };

  const daily = [];
  const weekly = [];
  const monthly = [];
  const weeklyWeeks = new Set();
  const monthlyMonths = new Set();
  const deleted = [];

  for (const name of names) {
    const [y, m, d] = name.split("-").map((n) => parseInt(n, 10));
    const date = new Date(y, m - 1, d);

    if (daily.length < 4) {
      daily.push(name);
      continue;
    }

    const wk = isoWeekKey(date);
    if (!weeklyWeeks.has(wk) && weekly.length < 4) {
      weekly.push(name);
      weeklyWeeks.add(wk);
      continue;
    }

    const mk = monthKey(date);
    if (!monthlyMonths.has(mk) && monthly.length < 4) {
      monthly.push(name);
      monthlyMonths.add(mk);
      continue;
    }

    // Not promoted to any bucket -> delete
    const dir = path.join(root, name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      deleted.push(name);
    } catch (err) {
      console.error(`Failed to delete ${dir}: ${err.message}`);
    }
  }

  const kept = [...daily, ...weekly, ...monthly];
  return { kept, deleted, daily, weekly, monthly };
}

async function runBackupNow(dataDir, db, appState) {
  try {
    // Wait out any in-flight refresh so VACUUM INTO doesn't race with
    // SQLite writes. Noop if no appState was wired (e.g. test harness).
    if (appState) {
      const { waitForRefreshIdle } = require("./refresh");
      await waitForRefreshIdle(appState);
    }
    const { dir, files } = createBackup(dataDir, db);
    const { kept, deleted } = applyRetention(dataDir);
    console.log(
      `[backup] wrote ${path.basename(dir)} (${files.join(", ") || "nothing"}); ` +
        `kept ${kept.length}${deleted.length ? `, deleted ${deleted.length} (${deleted.join(", ")})` : ""}`,
    );
  } catch (err) {
    console.error(`[backup] failed: ${err.message}`);
  }
}

// ms until next 1:00:00 AM local time.
function msUntilNext1am(now = new Date()) {
  const next = new Date(now);
  next.setHours(1, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// Kick off a backup if the most recent one is older than 25 hours (or none exists).
function catchUpIfStale(dataDir, db, appState) {
  const names = listBackups(dataDir);
  if (names.length === 0) {
    console.log("[backup] no prior backup found, creating initial backup");
    runBackupNow(dataDir, db, appState);
    return;
  }
  const latest = names[0]; // newest first
  const [y, m, d] = latest.split("-").map((n) => parseInt(n, 10));
  const latestDate = new Date(y, m - 1, d);
  const ageHours = (Date.now() - latestDate.getTime()) / 3600000;
  if (ageHours > 25) {
    console.log(`[backup] most recent backup is ${ageHours.toFixed(0)}h old, creating catch-up backup`);
    runBackupNow(dataDir, db, appState);
  }
}

function scheduleBackups(dataDir, db, appState) {
  ensureBackupsDir(dataDir);
  catchUpIfStale(dataDir, db, appState);

  function scheduleNext() {
    const delay = msUntilNext1am();
    const when = new Date(Date.now() + delay);
    console.log(`[backup] next run at ${when.toString()} (in ${(delay / 3600000).toFixed(1)}h)`);
    setTimeout(() => {
      runBackupNow(dataDir, db, appState);
      scheduleNext(); // recompute next 1am to be DST-safe
    }, delay);
  }

  scheduleNext();
}

module.exports = {
  createBackup,
  applyRetention,
  runBackupNow,
  scheduleBackups,
  listBackups,
  // exported for testing
  isoWeekKey,
  monthKey,
  localDateString,
  msUntilNext1am,
};
