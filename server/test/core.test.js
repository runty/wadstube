const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");

const Db = require("../lib/db");
const dataLib = require("../lib/data");
const youtube = require("../lib/youtube");
const {
  tryAcquireLock,
  releaseLock,
  refreshChannels,
} = require("../lib/refresh");
const { restoreData } = require("../lib/restore");
const { corsOriginPolicy } = require("../lib/security");

const CHANNEL_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_B = "UCbbbbbbbbbbbbbbbbbbbbbb";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function folder(id, name, channels = [], children = []) {
  return { id, name, channels, children };
}

test("legacy DB migration preserves data and separates visible retention", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "legacy.db");
  const legacy = new Database(file);
  legacy.exec([
    "CREATE TABLE channels (id TEXT PRIMARY KEY,title TEXT NOT NULL DEFAULT 'Unknown',last_checked_at TEXT,last_etag TEXT,last_modified TEXT);",
    "CREATE TABLE videos (video_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',thumbnail TEXT NOT NULL DEFAULT '',published TEXT NOT NULL,is_short INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);",
    `INSERT INTO channels(id,title) VALUES ('${CHANNEL_A}','Test');`,
    `INSERT INTO videos VALUES ('old-long','${CHANNEL_A}','Long','','','2026-01-01',0,'2026-01-01');`,
    `INSERT INTO videos VALUES ('old-short','${CHANNEL_A}','Short','','','2026-01-02',1,'2026-01-02');`,
  ].join("\n"));
  legacy.close();

  const db = new Db(file);
  t.after(() => db.close());
  assert.equal(db.db.pragma("user_version", { simple: true }), 8);
  assert.deepEqual(
    db.db
      .prepare("SELECT video_id, short_status FROM videos ORDER BY video_id")
      .all(),
    [
      { video_id: "old-long", short_status: "long" },
      { video_id: "old-short", short_status: "short" },
    ],
  );

  for (let i = 0; i < 5; i++) {
    db.upsertVideos([{
      video_id: `long-${i}`,
      channel_id: CHANNEL_A,
      title: `Long ${i}`,
      published: `2026-02-0${i + 1}`,
      short_status: "long",
    }]);
    db.upsertVideos([{
      video_id: `short-${i}`,
      channel_id: CHANNEL_A,
      title: `Short ${i}`,
      published: `2026-03-0${i + 1}`,
      short_status: "short",
    }]);
  }
  db.upsertVideos([{
    video_id: "retry",
    channel_id: CHANNEL_A,
    title: "Retry",
    published: "2026-04-01",
    short_status: "unknown",
  }]);
  db.upsertVideos([{
    video_id: "retry",
    channel_id: CHANNEL_A,
    title: "Retry",
    published: "2026-04-01",
    short_status: "short",
  }]);
  assert.equal(db.getVideoClassification("retry"), "short");
  db.pruneChannel(CHANNEL_A, 3);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) n FROM videos WHERE short_status != 'short'").get().n,
    3,
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) n FROM videos WHERE short_status = 'short'").get().n,
    3,
  );
  assert.equal(db.queryVideos({ limit: 20 }).some((v) => v.video_id === "retry"), false);
});

test("reader state, favorites, highlights, and health survive additive migration", (t) => {
  const dir = tempDir(t);
  const db = new Db(path.join(dir, "reader.db"));
  t.after(() => db.close());
  db.upsertChannel(CHANNEL_A, "Favorite");
  db.upsertChannel(CHANNEL_B, "Regular");
  db.upsertVideos([
    { video_id: "reader-a", channel_id: CHANNEL_A, title: "A", published: "2026-01-02", short_status: "long" },
    { video_id: "reader-b", channel_id: CHANNEL_B, title: "B", published: "2026-01-01", short_status: "long" },
  ]);
  db.db.prepare("UPDATE videos SET highlight_reason = ? WHERE video_id = ?").run("returned after 1 year", "reader-a");

  assert.equal(db.getUnreadCounts()[CHANNEL_A], 1);
  db.setChannelFavorite(CHANNEL_A, true);
  db.updateChannelHealth(CHANNEL_A, {
    status: "error", error: "rate limited", checkedAt: "2026-01-03T00:00:00.000Z",
  });
  assert.equal(db.listChannelHealth({ favorite: true })[0].id, CHANNEL_A);
  assert.equal(db.listChannelHealth({ status: "error" })[0].last_error, "rate limited");

  let state = db.setVideoState("reader-a", { watched_at: true, starred_at: true });
  assert.equal(state.watched, true);
  assert.equal(state.starred, true);
  assert.equal(db.queryVideos({ view: "unread" }).some((row) => row.video_id === "reader-a"), false);
  const starred = db.queryVideos({ view: "starred" });
  assert.equal(starred[0].highlight_reason, "returned after 1 year");
  assert.equal(starred[0].channel_favorite, true);

  state = db.setVideoState("reader-a", { watched_at: false, hidden_at: true });
  assert.equal(state.watched, false);
  assert.equal(db.queryVideos({ view: "all" }).some((row) => row.video_id === "reader-a"), false);
  assert.equal(db.queryVideos({ view: "hidden" })[0].video_id, "reader-a");
});

test("reader and channel preference APIs expose durable state", async (t) => {
  const dir = tempDir(t);
  const db = new Db(path.join(dir, "api.db"));
  t.after(() => db.close());
  db.upsertChannel(CHANNEL_A, "Reader API");
  db.upsertVideos([{
    video_id: "api-video", channel_id: CHANNEL_A, title: "API Video",
    published: "2026-01-01", short_status: "long",
  }]);
  const membership = { id: CHANNEL_A, name: "Reader API", addedAt: "2026-01-01" };
  const data = { version: 1, folders: [folder("folder-reader", "Reader", [membership], [
    folder("folder-child", "Child", [{ ...membership }]),
    folder("folder-never", "Never", [{ id: CHANNEL_B, name: "Never refreshed", addedAt: "2026-01-01" }]),
  ]), folder("folder-empty", "Empty")] };
  const appState = {
    data, db, maxVideos: 50, manualMode: "rss", apiKey: null, refreshLock: null,
    refreshChannels: async () => {
      db.updateChannelHealth(CHANNEL_A, { status: "error", error: "exact retry failure", checkedAt: new Date().toISOString() });
      return { checked: 1, updated: 0, new_videos: 0, errors: 1 };
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/videos", require("../routes/videos")(appState));
  app.use("/api/channels", require("../routes/channels")(appState));
  app.use("/api/folders", require("../routes/folders")(appState));
  app.use("/api/refresh", require("../routes/refresh")(appState));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  let response = await fetch(`${base}/folders`);
  const folderSummary = await response.json();
  assert.equal(folderSummary[0].unreadCount, 1, "duplicate memberships count once");
  assert.equal(folderSummary[0].children[0].unreadCount, 1);

  response = await fetch(`${base}/folders/folder-reader/channels`);
  assert.equal(response.headers.get("deprecation"), null);
  response = await fetch(`${base}/folders/Reader/channels`);
  assert.equal(response.headers.get("deprecation"), "true");

  response = await fetch(`${base}/videos?folder=Reader`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("deprecation"), "true");
  response = await fetch(`${base}/videos?folder=folder-reader`);
  assert.equal(response.headers.get("deprecation"), null);

  response = await fetch(`${base}/refresh/Empty`, { method: "POST" });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("deprecation"), "true");

  response = await fetch(`${base}/channels`);
  assert.equal((await response.json()).some((channel) => channel.id === CHANNEL_B), true,
    "health seeds never-refreshed subscriptions");

  response = await fetch(`${base}/channels/${CHANNEL_A}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite: true }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).channel.favorite, true);

  response = await fetch(`${base}/videos/api-video/state`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ watched: true, starred: true }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state.starred, true);
  assert.equal((await (await fetch(`${base}/videos?view=unread`)).json()).videos.length, 0);
  const starred = await (await fetch(`${base}/videos?view=starred&favorites=1`)).json();
  assert.equal(starred.videos[0].video_id, "api-video");
  assert.equal(starred.videos[0].channel_favorite, true);

  response = await fetch(`${base}/channels/${CHANNEL_A}/refresh`, { method: "POST" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "exact retry failure");
  for (let i = 0; i < 5; i++) {
    assert.equal((await fetch(`${base}/channels/${CHANNEL_A}/refresh`, { method: "POST" })).status, 502);
  }
  assert.equal((await fetch(`${base}/channels/${CHANNEL_A}/refresh`, { method: "POST" })).status, 429);
});

test("unresolved subscriptions stay visible and manageable without entering DB health", async (t) => {
  const dir = tempDir(t);
  const db = new Db(path.join(dir, "unresolved.db"));
  t.after(() => db.close());
  const legacyId = "https://www.youtube.com/c/LegacyChannel";
  const data = dataLib.normalizeTubeData({
    version: 1,
    folders: [
      folder("source", "Source", [
        { id: legacyId, name: "Legacy channel", addedAt: "2020-01-01" },
        { id: "__proto__", name: "Reserved prototype", addedAt: "2020-01-02" },
        { id: "constructor", name: "Reserved constructor", addedAt: "2020-01-03" },
      ]),
      folder("destination", "Destination"),
    ],
  });
  dataLib.saveData(dir, data);
  const appState = {
    data, dataDir: dir, db, apiKey: null, quota: null, refreshLock: null,
    refreshIntervalMinutes: 30, manualMode: "rss", maxVideos: 50,
  };
  const app = express();
  app.use(express.json());
  app.use("/api/folders", require("../routes/folders")(appState));
  app.use("/api/channels", require("../routes/channels")(appState));
  app.use("/api/refresh", require("../routes/refresh")(appState));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const encoded = encodeURIComponent(legacyId);

  let response = await fetch(`${base}/folders/source/channels`);
  let channels = await response.json();
  const legacyChannel = channels.find((channel) => channel.id === legacyId);
  assert.equal(legacyChannel.unresolved, true);
  assert.equal(legacyChannel.unreadCount, 0);
  for (const reserved of ["__proto__", "constructor"]) {
    const channel = channels.find((item) => item.id === reserved);
    assert.equal(channel.unresolved, true);
    assert.equal(channel.unreadCount, 0);
  }
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(db.getChannelMeta(legacyId), null);

  response = await fetch(`${base}/refresh/source`, { method: "POST" });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  const report = events.find((event) => event.type === "summary");
  assert.equal(report.skipped, 3);
  assert.equal(report.api_calls, 0);
  assert.equal(report.rss_requests, 0);
  assert.equal(report.errors, 0);

  response = await fetch(`${base}/folders/source/channels/${encoded}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destFolder: "destination" }),
  });
  assert.equal(response.status, 200);
  channels = await (await fetch(`${base}/folders/destination/channels`)).json();
  assert.equal(channels.some((channel) => channel.id === legacyId && channel.unresolved), true);

  response = await fetch(`${base}/channels/${encoded}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite: true }),
  });
  assert.equal(response.status, 409);
  assert.equal((await (await fetch(`${base}/channels`)).json()).some((channel) => channel.id === legacyId), false);
  assert.equal(db.getChannelMeta(legacyId), null);

  response = await fetch(`${base}/folders/destination/channels/${encoded}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal(data.folders[1].channels.length, 0);
  assert.equal(data.folders[0].channels.length, 2);

  response = await fetch(`${base}/folders/source/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId: "new-invalid-id" }),
  });
  assert.equal(response.status, 400);
});

test("normalization reports losses and startup repairs persist stable IDs", (t) => {
  const detail = dataLib.normalizeTubeDataDetailed({
    version: 1,
    folders: [{ name: "Keep", channels: [{ id: "" }], children: [] }],
  });
  assert.equal(detail.report.losses.length, 1);
  assert.match(detail.report.losses[0], /invalid channel ID/);

  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, "tube.json"),
    JSON.stringify({ version: 1, folders: [{ name: "Needs ID" }] }),
  );
  const first = dataLib.loadData(dir);
  const generatedId = first.folders[0].id;
  assert.match(generatedId, /^folder-[0-9a-f-]+$/);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "tube.json")));
  assert.equal(persisted.folders[0].id, generatedId);
  assert.equal(dataLib.loadData(dir).folders[0].id, generatedId);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.includes(".pre-normalize.")),
    true,
  );
});

test("legacy URL subscriptions are quarantined without reducing a 2,381-entry library", async (t) => {
  const legacyIds = [
    "https://www.youtube.com/c/ASMRDivinity",
    "https://www.youtube.com/c/OzleyASMR",
    "https://www.youtube.com/c/ASMRShortbread",
    "https://www.youtube.com/user/quyaour",
    "https://www.youtube.com/user/Marcusscalius",
    "https://www.youtube.com/user/TheBluRayCritic",
    "https://www.youtube.com/",
    "https://www.youtube.com/c/PickleballKitchen",
    "https://www.youtube.com/user/azamsharp",
    "https://www.youtube.com/c/ThisMessyHappy",
  ];
  const resolved = Array.from({ length: 2_371 }, (_, index) => ({
    id: `UC${index.toString(36).padStart(22, "0")}`,
    name: `Resolved ${index}`,
    addedAt: "2026-01-01T00:00:00.000Z",
  }));
  const legacy = legacyIds.map((id, index) => ({
    id, name: `Legacy ${index}`, addedAt: `2020-01-${String(index + 1).padStart(2, "0")}`,
  }));
  const uploaded = {
    version: 1,
    folders: [folder("library", "Library", [...resolved, ...legacy])],
  };
  const normalized = dataLib.normalizeTubeDataDetailed(uploaded);
  assert.equal(normalized.report.losses.length, 0);
  assert.equal(normalized.data.folders[0].channels.length, 2_381);
  assert.equal(normalized.data.folders[0].channels.filter((channel) => channel.unresolved).length, 10);
  assert.deepEqual(
    normalized.data.folders[0].channels.slice(-10).map(({ id, name, addedAt, unresolved }) => ({ id, name, addedAt, unresolved })),
    legacy.map((channel) => ({ ...channel, unresolved: true })),
  );
  const refreshIds = dataLib.collectAllChannelIds(normalized.data.folders[0]);
  assert.equal(refreshIds.length, 2_371);
  assert.equal(refreshIds.every((id) => dataLib.CHANNEL_ID_RE.test(id)), true);
  assert.equal(legacyIds.some((id) => refreshIds.includes(id)), false);
  assert.equal(
    [...dataLib.allReferencedChannelIds(normalized.data)].every((id) => dataLib.CHANNEL_ID_RE.test(id)),
    true,
  );
  assert.equal(dataLib.getFolderTreeSummary(normalized.data)[0].channelCount, 2_381);
  assert.equal(dataLib.getFolderTreeSummary(normalized.data)[0].unresolvedCount, 10);
  assert.throws(
    () => dataLib.addChannel(normalized.data, "library", "not-a-new-channel-id", "Rejected"),
    /Invalid YouTube channel ID/,
  );

  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "tube.json"), JSON.stringify(uploaded, null, 2));
  const started = dataLib.loadData(dir);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "tube.json"), "utf8"));
  assert.equal(started.folders[0].channels.length, 2_381);
  assert.equal(persisted.folders[0].channels.length, 2_381);
  assert.equal(persisted.folders[0].channels.filter((channel) => channel.unresolved).length, 10);

  const db = new Db(path.join(dir, "wadstube.db"));
  t.after(() => db.close());
  const appState = {
    data: { version: 1, folders: [] }, dataDir: dir, db, refreshLock: null,
  };
  const restored = await restoreData(appState, persisted);
  assert.equal(restored.normalizationRepairs.length, 0);
  assert.equal(restored.data.folders[0].channels.length, 2_381);
  assert.equal(restored.data.folders[0].channels.filter((channel) => channel.unresolved).length, 10);
});

test("PocketTube migration creates stable collision-free folder IDs", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, "youtube_subscription_manager_test.json"),
    JSON.stringify({
      "A B": [CHANNEL_A, "https://www.youtube.com/c/LegacyPocketTube"],
      "A-B": [CHANNEL_B],
      ysc_settings: {},
    }),
  );
  const migrated = dataLib.loadData(dir);
  const ids = migrated.folders.map((item) => item.id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids.every((id) => /^folder-[0-9a-f-]+$/.test(id)), true);
  const legacy = migrated.folders.flatMap((item) => item.channels)
    .find((channel) => channel.id.includes("LegacyPocketTube"));
  assert.equal(legacy.unresolved, true);
  assert.equal(
    migrated.folders.flatMap((item) => dataLib.collectAllChannelIds(item)).includes(legacy.id),
    false,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, "tube.json"))).folders.map((item) => item.id),
    ids,
  );
});

test("restore waits for refresh, snapshots JSON and SQLite, then purges", async (t) => {
  const dir = tempDir(t);
  const db = new Db(path.join(dir, "wadstube.db"));
  t.after(() => db.close());
  db.upsertChannel(CHANNEL_A, "Keep");
  db.upsertChannel(CHANNEL_B, "Remove");
  db.upsertVideos([{
    video_id: "remove-video",
    channel_id: CHANNEL_B,
    title: "Remove",
    published: "2026-01-01",
    short_status: "long",
  }]);
  const original = {
    version: 1,
    folders: [folder("old", "Old", [
      { id: CHANNEL_A, name: "Keep", addedAt: "2026-01-01" },
      { id: CHANNEL_B, name: "Remove", addedAt: "2026-01-01" },
    ])],
  };
  dataLib.saveData(dir, original);
  const appState = { data: original, dataDir: dir, db, refreshLock: null };
  const held = tryAcquireLock(appState);
  let finished = false;
  const restoring = restoreData(appState, {
    version: 1,
    folders: [folder("new", "New", [
      { id: CHANNEL_A, name: "Keep", addedAt: "2026-01-01" },
    ])],
  }).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false);
  releaseLock(appState, held);
  const result = await restoring;
  assert.equal(result.purgedChannels, 1);
  const snapshotDir = path.join(dir, result.snapshotName);
  assert.equal(fs.existsSync(path.join(snapshotDir, "tube.json")), true);
  assert.equal(fs.existsSync(path.join(snapshotDir, "wadstube.db")), true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(snapshotDir, "tube.json"))).folders[0].name,
    "Old",
  );
  const snapshot = new Database(path.join(snapshotDir, "wadstube.db"), { readonly: true });
  assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM channels").get().n, 2);
  snapshot.close();
  assert.equal(db.getChannelMeta(CHANNEL_B), null);

  await assert.rejects(
    () => restoreData(appState, {
      version: 1,
      folders: [folder("bad", "Bad", [{ id: "" }])],
    }),
    (err) => err.status === 400 && err.details.some((item) => item.includes("invalid channel ID")),
  );
  const snapshotsBefore = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("pre-restore-")).length;
  await assert.rejects(
    () => restoreData(appState, { version: 2, folders: [] }),
    (err) =>
      err.status === 400 &&
      err.details.some((item) => item.includes("unsupported backup version 2")),
  );
  assert.equal(
    fs.readdirSync(dir).filter((name) => name.startsWith("pre-restore-")).length,
    snapshotsBefore,
  );
});

test("destructive channel removal waits for refresh and purges final rows", async (t) => {
  const dir = tempDir(t);
  const db = new Db(path.join(dir, "wadstube.db"));
  const data = {
    version: 1,
    folders: [folder("root", "Root", [
      { id: CHANNEL_A, name: "Channel", addedAt: "2026-01-01" },
    ])],
  };
  dataLib.saveData(dir, data);
  db.upsertChannel(CHANNEL_A, "Channel");
  const appState = {
    data,
    dataDir: dir,
    db,
    apiKey: null,
    refreshLock: null,
  };
  const app = express();
  app.use(express.json());
  app.use("/api/folders", require("../routes/folders")(appState));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => db.close());
  const address = server.address();
  const held = tryAcquireLock(appState);
  let responded = false;
  const request = fetch(
    `http://127.0.0.1:${address.port}/api/folders/root/channels/${CHANNEL_A}`,
    { method: "DELETE" },
  ).then((response) => {
    responded = true;
    return response;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(responded, false);
  // Simulate the in-flight refresh's last write before it releases its lock.
  db.upsertChannel(CHANNEL_A, "Reinserted");
  db.upsertVideos([{
    video_id: "late",
    channel_id: CHANNEL_A,
    title: "Late",
    published: "2026-01-02",
    short_status: "long",
  }]);
  releaseLock(appState, held);
  assert.equal((await request).status, 200);
  assert.equal(db.getChannelMeta(CHANNEL_A), null);
});

test("allowlisted CORS supports preflight and public proxy origin", async (t) => {
  const app = express();
  app.use(corsOriginPolicy(["https://ui.example"], "https://tube.example"));
  app.get("/api/value", (_req, res) => res.json({ ok: true }));
  app.post("/api/value", (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/value`;

  const preflight = await fetch(base, {
    method: "OPTIONS",
    headers: {
      Origin: "https://ui.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://ui.example");
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);

  const publicOrigin = await fetch(base, {
    method: "POST",
    headers: { Origin: "https://tube.example" },
  });
  assert.equal(publicOrigin.status, 200);
  assert.equal(publicOrigin.headers.get("access-control-allow-origin"), "https://tube.example");
  assert.equal(
    (
      await fetch(base, {
        method: "POST",
        headers: { Origin: `http://127.0.0.1:${port}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(base, { method: "POST", headers: { Origin: "https://evil.example" } })).status,
    403,
  );
  assert.equal(
    (
      await fetch(base, {
        method: "POST",
        headers: { Origin: `https://127.0.0.1:${port}` },
      })
    ).status,
    403,
  );

  const proxyApp = express();
  proxyApp.set("trust proxy", 1);
  proxyApp.use(corsOriginPolicy());
  proxyApp.post("/api/value", (_req, res) => res.json({ ok: true }));
  const proxyServer = await new Promise((resolve) => {
    const listening = proxyApp.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => proxyServer.close(resolve)));
  const proxyResponse = await fetch(
    `http://127.0.0.1:${proxyServer.address().port}/api/value`,
    {
      method: "POST",
      headers: {
        Origin: "https://tube.proxy.example",
        "X-Forwarded-Host": "tube.proxy.example",
        "X-Forwarded-Proto": "https",
      },
    },
  );
  assert.equal(proxyResponse.status, 200);
  assert.equal(
    proxyResponse.headers.get("access-control-allow-origin"),
    "https://tube.proxy.example",
  );
});

test("YouTube resolution and HTTP error mapping are actionable", async (t) => {
  let request;
  let mode = "success";
  t.mock.method(global, "fetch", async (url, options) => {
    request = { url: String(url), options };
    if (mode === "quota") {
      return {
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: async () => ({
          error: { errors: [{ reason: "quotaExceeded", message: "Quota exhausted" }] },
        }),
      };
    }
    if (mode === "empty") {
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }
    if (mode === "malformed") {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ id: CHANNEL_A, snippet: { title: "Exact" } }],
      }),
    };
  });
  const resolved = await youtube.resolveUrl("secret", "https://youtube.com/@exact");
  assert.equal(resolved.channelId, CHANNEL_A);
  assert.match(request.url, /forHandle=%40exact/);
  assert.doesNotMatch(request.url, /(?:\?|&)key=/);
  assert.equal(request.options.headers["x-goog-api-key"], "secret");
  mode = "quota";
  let quotaError;
  await assert.rejects(
    () => youtube.resolveUrl("secret", "https://youtube.com/@exact"),
    (err) => {
      quotaError = err;
      return /quotaExceeded.*Quota exhausted/.test(err.message);
    },
  );
  assert.equal(youtube.httpStatusForYoutubeError(quotaError), 429);
  mode = "empty";
  await assert.rejects(
    () => youtube.resolveUrl("secret", "https://youtube.com/@missing"),
    (err) => youtube.httpStatusForYoutubeError(err) === 404,
  );
  mode = "malformed";
  await assert.rejects(
    () => youtube.resolveUrl("secret", "https://youtube.com/@broken"),
    (err) =>
      err.code === "youtubeUnavailable" &&
      youtube.httpStatusForYoutubeError(err) === 502,
  );
  assert.equal(youtube.httpStatusForYoutubeError({ code: "quotaExceeded" }), 429);
  assert.equal(youtube.httpStatusForYoutubeError({ code: "notFound" }), 404);
  assert.equal(youtube.httpStatusForYoutubeError({ code: "invalidInput" }), 400);
  assert.equal(youtube.httpStatusForYoutubeError({ code: "apiKeyRequired" }), 503);
  assert.equal(youtube.httpStatusForYoutubeError({ status: 503 }), 502);
});

test("refresh reports visible videos separately from filtered Shorts", async (t) => {
  const statuses = new Map();
  const fakeDb = {
    getChannelMeta: () => ({
      id: CHANNEL_A,
      title: "Test",
      last_etag: null,
      last_modified: null,
    }),
    upsertChannel() {},
    updateChannelMeta() {},
    pruneChannel() {},
    getVideoClassification: (id) => statuses.get(id) || null,
    upsertVideos(rows) {
      for (const row of rows) statuses.set(row.video_id, row.short_status || "long");
    },
  };
  t.mock.method(global, "fetch", async (url) => {
    const value = String(url);
    if (value.includes("/playlistItems?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [
          { snippet: { channelId: CHANNEL_A, channelTitle: "Test", title: "Visible", publishedAt: "2026-01-01", resourceId: { videoId: "visible" }, thumbnails: {} } },
          { snippet: { channelId: CHANNEL_A, channelTitle: "Test", title: "Short", publishedAt: "2026-01-02", resourceId: { videoId: "filtered" }, thumbnails: {} } },
        ] }),
      };
    }
    return { status: value.endsWith("/filtered") ? 200 : 303 };
  });
  const summary = await refreshChannels(
    fakeDb,
    [CHANNEL_A],
    { mode: "api", apiKey: "key", keep: 50 },
  );
  assert.equal(summary.new_videos, 1);
  assert.equal(summary.new_shorts, 1);
  assert.equal(summary.classification_unknown, 0);
});
