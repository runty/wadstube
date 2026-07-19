const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { acquireLockWhenIdle, releaseLock } = require("./refresh");

const BLOCK = 512;
const ALLOWED_ENTRIES = new Set(["manifest.json", "tube.json", "wadstube.db"]);

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function writeText(buffer, offset, length, value) {
  buffer.write(String(value).slice(0, length), offset, length, "utf8");
}

function writeOctal(buffer, offset, length, value) {
  writeText(buffer, offset, length, `${Number(value).toString(8).padStart(length - 1, "0")}\0`);
}

function tarHeader(name, size, mtime = Date.now()) {
  const header = Buffer.alloc(BLOCK);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(mtime / 1000));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function appendFileToTar(archiveFd, name, filePath) {
  const stat = fs.statSync(filePath);
  fs.writeSync(archiveFd, tarHeader(name, stat.size, stat.mtimeMs));
  const sourceFd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    while (position < stat.size) {
      const read = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!read) throw new Error(`Unexpected EOF while archiving ${name}`);
      fs.writeSync(archiveFd, buffer, 0, read);
      position += read;
    }
  } finally { fs.closeSync(sourceFd); }
  const padding = (BLOCK - (stat.size % BLOCK)) % BLOCK;
  if (padding) fs.writeSync(archiveFd, Buffer.alloc(padding));
}

async function createFullBackup(dataDir, db, appState, { outputDir = os.tmpdir() } = {}) {
  const handle = await acquireLockWhenIdle(appState);
  let workDir = null;
  try {
    workDir = fs.mkdtempSync(path.join(outputDir, "wadstube-full-backup-"));
    const snapshotPath = path.join(workDir, "wadstube.db");
    const tubePath = path.join(workDir, "tube.json");
    db.vacuumInto(snapshotPath);
    fs.writeFileSync(tubePath, JSON.stringify(appState.data, null, 2) + "\n");

    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    let integrity;
    try { integrity = snapshot.pragma("quick_check", { simple: true }); }
    finally { snapshot.close(); }
    if (integrity !== "ok") throw new Error(`SQLite snapshot integrity check failed: ${integrity}`);

    const createdAt = new Date().toISOString();
    const [tubeInfo, dbInfo] = await Promise.all([sha256File(tubePath), sha256File(snapshotPath)]);
    const manifest = {
      format: "wadstube-full-backup",
      version: 2,
      createdAt,
      appDataVersion: appState.data.version,
      sqliteQuickCheck: integrity,
      files: {
        "tube.json": tubeInfo,
        "wadstube.db": dbInfo,
      },
    };
    const manifestPath = path.join(workDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const timestamp = createdAt.replace(/[:.]/g, "-").slice(0, 19);
    const filePath = path.join(workDir, `wadstube-full-${timestamp}.tar`);
    const archiveFd = fs.openSync(filePath, "wx");
    try {
      appendFileToTar(archiveFd, "manifest.json", manifestPath);
      appendFileToTar(archiveFd, "tube.json", tubePath);
      appendFileToTar(archiveFd, "wadstube.db", snapshotPath);
      fs.writeSync(archiveFd, Buffer.alloc(BLOCK * 2));
      fs.fsyncSync(archiveFd);
    } finally { fs.closeSync(archiveFd); }
    return {
      filePath,
      filename: path.basename(filePath),
      manifest,
      cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }),
    };
  } catch (err) {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    throw err;
  } finally {
    releaseLock(appState, handle);
  }
}

function readExact(fd, buffer, offset, length, position) {
  let total = 0;
  while (total < length) {
    const count = fs.readSync(fd, buffer, offset + total, length - total, position + total);
    if (!count) throw new Error("Unexpected end of archive");
    total += count;
  }
}

async function verifyFullBackup(filePath, { extractDir = null } = {}) {
  let extractCreated = false;
  if (extractDir && fs.existsSync(extractDir)) {
    throw new Error("Extraction directory must not already exist");
  }
  const fd = fs.openSync(filePath, "r");
  if (extractDir) {
    fs.mkdirSync(extractDir, { recursive: true });
    extractCreated = true;
  }
  const found = {};
  let manifest = null;
  let position = 0;
  try {
    while (true) {
      const header = Buffer.alloc(BLOCK);
      readExact(fd, header, 0, BLOCK, position);
      position += BLOCK;
      if (header.every((byte) => byte === 0)) break;
      const storedChecksum = parseInt(
        header.toString("ascii", 148, 156).replace(/\0.*$/, "").trim() || "0",
        8,
      );
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
      if (storedChecksum !== actualChecksum) throw new Error("Invalid TAR header checksum");
      const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
      if (!ALLOWED_ENTRIES.has(name)) throw new Error(`Unexpected archive entry "${name}"`);
      if (found[name]) throw new Error(`Duplicate archive entry "${name}"`);
      const sizeText = header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim();
      const size = parseInt(sizeText || "0", 8);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid size for ${name}`);
      const hash = crypto.createHash("sha256");
      const manifestChunks = [];
      let outputFd = null;
      if (extractDir && name !== "manifest.json") {
        outputFd = fs.openSync(path.join(extractDir, name), "wx");
      }
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let consumed = 0;
        while (consumed < size) {
          const count = Math.min(buffer.length, size - consumed);
          readExact(fd, buffer, 0, count, position + consumed);
          const chunk = buffer.subarray(0, count);
          hash.update(chunk);
          if (name === "manifest.json") manifestChunks.push(Buffer.from(chunk));
          if (outputFd !== null) fs.writeSync(outputFd, chunk);
          consumed += count;
        }
      } finally { if (outputFd !== null) fs.closeSync(outputFd); }
      found[name] = { bytes: size, sha256: hash.digest("hex") };
      if (name === "manifest.json") manifest = JSON.parse(Buffer.concat(manifestChunks).toString("utf8"));
      position += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    }
  } catch (err) {
    if (extractCreated) fs.rmSync(extractDir, { recursive: true, force: true });
    throw err;
  } finally { fs.closeSync(fd); }

  const rejectArchive = (message) => {
    if (extractCreated) fs.rmSync(extractDir, { recursive: true, force: true });
    throw new Error(message);
  };

  if (!manifest || manifest.format !== "wadstube-full-backup" || manifest.version !== 2) {
    rejectArchive("Unsupported or missing WadsTube full-backup manifest");
  }
  for (const name of ["tube.json", "wadstube.db"]) {
    const expected = manifest.files?.[name];
    const actual = found[name];
    if (!expected || !actual || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) {
      rejectArchive(`${name} checksum verification failed`);
    }
  }
  if (extractDir) {
    try {
      const tube = JSON.parse(fs.readFileSync(path.join(extractDir, "tube.json"), "utf8"));
      if (!tube || !Array.isArray(tube.folders)) throw new Error("Extracted tube.json is invalid");
      const snapshot = new Database(path.join(extractDir, "wadstube.db"), {
        readonly: true,
        fileMustExist: true,
      });
      let integrity;
      try { integrity = snapshot.pragma("quick_check", { simple: true }); }
      finally { snapshot.close(); }
      if (integrity !== "ok") throw new Error(`Extracted SQLite quick_check failed: ${integrity}`);
    } catch (err) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      throw err;
    }
  }
  return { ok: true, manifest, files: found, extractDir };
}

module.exports = { createFullBackup, verifyFullBackup, sha256File };
