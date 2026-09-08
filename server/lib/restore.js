const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  normalizeTubeDataDetailed,
  saveData,
  allReferencedChannelIds,
} = require("./data");
const { acquireLockWhenIdle, releaseLock } = require("./refresh");

class RestoreValidationError extends Error {
  constructor(losses) {
    super("Restore rejected because normalization would drop data");
    this.code = "restoreValidation";
    this.status = 400;
    this.details = losses;
  }
}

async function restoreData(appState, uploaded, now = new Date()) {
  if (uploaded?.version !== undefined && uploaded.version !== 1) {
    throw new RestoreValidationError([
      `version: unsupported backup version ${JSON.stringify(uploaded.version)}; expected 1`,
    ]);
  }
  const normalized = normalizeTubeDataDetailed(uploaded);
  if (normalized.report.losses.length) {
    throw new RestoreValidationError(normalized.report.losses);
  }

  const handle = await acquireLockWhenIdle(appState);
  let snapshotName = null;
  try {
    const timestamp = now
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 23);
    snapshotName = `pre-restore-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
    const snapshotDir = path.join(appState.dataDir, snapshotName);
    fs.mkdirSync(snapshotDir, { recursive: false });

    // Do not alter live state until both recoverable source snapshots exist.
    fs.writeFileSync(
      path.join(snapshotDir, "tube.json"),
      JSON.stringify(appState.data, null, 2),
      "utf-8",
    );
    appState.db.vacuumInto(path.join(snapshotDir, "wadstube.db"));

    const previous = appState.data;
    saveData(appState.dataDir, normalized.data);
    let purgedChannels;
    try {
      // purgeOrphanChannels is a SQLite transaction: failure rolls it back.
      purgedChannels = appState.db.purgeOrphanChannels(
        allReferencedChannelIds(normalized.data),
      );
    } catch (err) {
      try { saveData(appState.dataDir, previous); }
      catch (rollbackError) {
        appState.recoveryRequired = snapshotName;
        err.message += `; file rollback failed: ${rollbackError.message}. Stop and recover from ${snapshotName} before restarting.`;
      }
      throw err;
    }
    appState.data = normalized.data;

    return {
      data: appState.data,
      purgedChannels,
      normalizationRepairs: normalized.report.repairs,
      snapshotName,
    };
  } catch (err) {
    if (snapshotName) err.restoreSnapshot = snapshotName;
    throw err;
  } finally {
    releaseLock(appState, handle);
  }
}

module.exports = { restoreData, RestoreValidationError };
