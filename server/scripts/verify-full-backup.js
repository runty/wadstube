#!/usr/bin/env node
const path = require("path");
const { verifyFullBackup } = require("../lib/full-backup");

async function main() {
  const args = process.argv.slice(2);
  const archive = args[0];
  const extractIndex = args.indexOf("--extract");
  const extractDir = extractIndex >= 0 ? args[extractIndex + 1] : null;
  if (!archive || (extractIndex >= 0 && !extractDir)) {
    console.error("Usage: node server/scripts/verify-full-backup.js BACKUP.tar [--extract DIRECTORY]");
    process.exitCode = 2;
    return;
  }
  const result = await verifyFullBackup(path.resolve(archive), {
    extractDir: extractDir ? path.resolve(extractDir) : null,
  });
  console.log(`Verified WadsTube full backup from ${result.manifest.createdAt}`);
  for (const [name, info] of Object.entries(result.manifest.files)) {
    console.log(`${name}: ${info.bytes} bytes sha256=${info.sha256}`);
  }
  if (result.extractDir) console.log(`Extracted verified files to ${result.extractDir}`);
}

main().catch((err) => {
  console.error(`Verification failed: ${err.message}`);
  process.exitCode = 1;
});
