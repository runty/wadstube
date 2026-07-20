const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { normalizeTubeDataDetailed } = require("./data");

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

function backupsRoot(dataDir) {
  return path.join(dataDir, "backups");
}

function validBackupDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, date] = value.split("-").map(Number);
  if (year < 1970 || year > 9999) return false;
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date;
}

function backupDirectory(dataDir, date) {
  if (!validBackupDate(date)) throw new Error("Backup date must be a valid YYYY-MM-DD date");
  const root = backupsRoot(dataDir);
  const directory = path.join(root, date);
  if (path.dirname(directory) !== root) throw new Error("Invalid backup path");
  return directory;
}

function verifyBackupDirectory(directory) {
  const tubePath = path.join(directory, "tube.json");
  const databasePath = path.join(directory, "wadstube.db");
  if (!fs.statSync(tubePath).isFile() || !fs.statSync(databasePath).isFile()) {
    throw new Error("Backup must contain tube.json and wadstube.db files");
  }

  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(tubePath, "utf8")); }
  catch (err) { throw new Error(`tube.json parse failed: ${err.message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      parsed.version !== 1 || !Array.isArray(parsed.folders)) {
    throw new Error("tube.json is not a supported WadsTube version 1 backup");
  }
  const normalized = normalizeTubeDataDetailed(parsed);
  if (normalized.report.losses.length) {
    throw new Error(`tube.json normalization would lose data: ${normalized.report.losses[0]}`);
  }

  let snapshot;
  let quickCheck;
  try {
    snapshot = new Database(databasePath, { readonly: true, fileMustExist: true });
    snapshot.pragma("query_only = ON");
    quickCheck = snapshot.pragma("quick_check", { simple: true });
  } catch (err) {
    throw new Error(`wadstube.db verification failed: ${err.message}`);
  } finally {
    try { snapshot?.close(); } catch {}
  }
  if (quickCheck !== "ok") throw new Error(`wadstube.db quick_check failed: ${quickCheck}`);

  return {
    ok: true,
    quickCheck,
    normalizationRepairs: normalized.report.repairs.length,
    files: {
      "tube.json": { bytes: fs.statSync(tubePath).size },
      "wadstube.db": { bytes: fs.statSync(databasePath).size },
    },
  };
}

function verifyBackup(dataDir, date) {
  const directory = backupDirectory(dataDir, date);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    const err = new Error(`Backup ${date} not found`);
    err.status = 404;
    throw err;
  }
  return { date, directory, ...verifyBackupDirectory(directory) };
}

function trackAppTask(appState, promise) {
  if (!appState) return promise;
  appState.activeTasks ||= new Set();
  appState.activeTasks.add(promise);
  promise.finally(() => appState.activeTasks.delete(promise));
  return promise;
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
    .filter((e) => {
      if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) return false;
      const dir = path.join(root, e.name);
      return fs.existsSync(path.join(dir, "tube.json")) &&
        fs.existsSync(path.join(dir, "wadstube.db"));
    })
    .map((e) => e.name)
    .sort()
    .reverse();
}

function listBackupDetails(dataDir, limit = 30) {
  const bounded = Number(limit);
  if (!Number.isInteger(bounded) || bounded < 1 || bounded > 100) {
    throw new Error("Backup limit must be an integer from 1 to 100");
  }
  return listBackups(dataDir).slice(0, bounded).map((date) => {
    const directory = backupDirectory(dataDir, date);
    const tube = fs.statSync(path.join(directory, "tube.json"));
    const database = fs.statSync(path.join(directory, "wadstube.db"));
    return {
      date,
      modifiedAt: new Date(Math.max(tube.mtimeMs, database.mtimeMs)).toISOString(),
      files: {
        "tube.json": { bytes: tube.size },
        "wadstube.db": { bytes: database.size },
      },
      totalBytes: tube.size + database.size,
    };
  });
}

function createBackup(dataDir, db) {
  const date = localDateString();
  const root = ensureBackupsDir(dataDir);
  const destDir = path.join(root, date);
  const stageDir = fs.mkdtempSync(path.join(root, `.${date}.stage-`));
  const oldDir = path.join(root, `.${date}.old-${process.pid}-${Date.now()}`);
  let oldPublished = false;
  try {
    const tubeSource = path.join(dataDir, "tube.json");
    if (!fs.existsSync(tubeSource)) throw new Error("tube.json is missing");
    if (!db) throw new Error("database snapshot provider is required");
    fs.copyFileSync(tubeSource, path.join(stageDir, "tube.json"));
    db.vacuumInto(path.join(stageDir, "wadstube.db"));
    const verification = verifyBackupDirectory(stageDir);

    // Publish the complete directory as a unit. If the second rename fails,
    // restore the prior directory before returning an error.
    if (fs.existsSync(destDir)) {
      fs.renameSync(destDir, oldDir);
      oldPublished = true;
    }
    try {
      fs.renameSync(stageDir, destDir);
    } catch (err) {
      if (oldPublished && !fs.existsSync(destDir)) fs.renameSync(oldDir, destDir);
      throw err;
    }
    if (oldPublished) {
      try { fs.rmSync(oldDir, { recursive: true, force: true }); }
      catch (err) { console.warn(`[backup] could not remove replaced snapshot ${oldDir}: ${err.message}`); }
    }
    return { dir: destDir, files: ["tube.json", "wadstube.db"], verification, ok: true };
  } catch (error) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
    if (oldPublished && fs.existsSync(oldDir) && !fs.existsSync(destDir)) {
      try { fs.renameSync(oldDir, destDir); } catch {}
    }
    return { dir: destDir, files: [], ok: false, error };
  }
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
  let handle = null;
  try {
    // Atomically become the exclusive owner after any in-flight refresh.
    // Merely observing an idle lock leaves a race where a new refresh can
    // start before VACUUM INTO begins.
    if (appState) {
      const { acquireLockWhenIdle } = require("./refresh");
      handle = await acquireLockWhenIdle(appState);
    }
    const { dir, files, ok, error } = createBackup(dataDir, db);
    if (!ok) throw error;
    const { kept, deleted } = applyRetention(dataDir);
    console.log(
      `[backup] wrote ${path.basename(dir)} (${files.join(", ") || "nothing"}); ` +
        `kept ${kept.length}${deleted.length ? `, deleted ${deleted.length} (${deleted.join(", ")})` : ""}`,
    );
    return { ok: true, dir, files, kept, deleted };
  } catch (err) {
    console.error(`[backup] failed: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    if (handle) {
      const { releaseLock } = require("./refresh");
      releaseLock(appState, handle);
    }
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
function catchUpIfStale(dataDir, run) {
  const names = listBackups(dataDir);
  if (names.length === 0) {
    console.log("[backup] no prior backup found, creating initial backup");
    run("initial");
    return;
  }
  const latest = names[0]; // newest first
  const [y, m, d] = latest.split("-").map((n) => parseInt(n, 10));
  const latestDate = new Date(y, m - 1, d);
  const ageHours = (Date.now() - latestDate.getTime()) / 3600000;
  if (ageHours > 25) {
    console.log(`[backup] most recent backup is ${ageHours.toFixed(0)}h old, creating catch-up backup`);
    run("catch-up");
  }
}

function scheduleBackups(dataDir, db, appState) {
  ensureBackupsDir(dataDir);
  let stopped = false;
  let timer = null;
  let currentTask = null;
  const state = {
    scheduled: true,
    running: false,
    currentReason: null,
    nextRunAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };

  function run(reason) {
    if (currentTask) return currentTask;
    state.running = true;
    state.currentReason = reason;
    state.lastStartedAt = new Date().toISOString();
    currentTask = runBackupNow(dataDir, db, appState).then((result) => {
      state.lastCompletedAt = new Date().toISOString();
      if (result.ok) {
        state.lastSuccessAt = state.lastCompletedAt;
        state.lastError = null;
      } else {
        state.lastFailureAt = state.lastCompletedAt;
        state.lastError = result.error;
      }
      return result;
    }).finally(() => {
      state.running = false;
      state.currentReason = null;
      currentTask = null;
    });
    return trackAppTask(appState, currentTask);
  }

  catchUpIfStale(dataDir, run);

  function scheduleNext() {
    if (stopped) return;
    const delay = msUntilNext1am();
    const when = new Date(Date.now() + delay);
    state.nextRunAt = when.toISOString();
    console.log(`[backup] next run at ${when.toString()} (in ${(delay / 3600000).toFixed(1)}h)`);
    timer = setTimeout(() => {
      run("scheduled");
      scheduleNext(); // recompute next 1am to be DST-safe
    }, delay);
  }

  scheduleNext();
  return {
    stop() {
      stopped = true;
      state.scheduled = false;
      state.nextRunAt = null;
      if (timer) clearTimeout(timer);
    },
    status() { return { ...state }; },
    runNow() { return run("manual"); },
  };
}

module.exports = {
  createBackup,
  applyRetention,
  runBackupNow,
  scheduleBackups,
  listBackups,
  listBackupDetails,
  verifyBackup,
  verifyBackupDirectory,
  validBackupDate,
  // exported for testing
  isoWeekKey,
  monthKey,
  localDateString,
  msUntilNext1am,
};
