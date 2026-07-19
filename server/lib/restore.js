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

    appState.data = normalized.data;
    saveData(appState.dataDir, appState.data);
    const referenced = allReferencedChannelIds(appState.data);
    const purgedChannels = appState.db.purgeOrphanChannels(referenced);

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
