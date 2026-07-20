const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");

const Db = require("../lib/db");
const {
  moveChannels,
  replaceUnresolvedChannel,
} = require("../lib/data");

const CHANNEL_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_B = "UCbbbbbbbbbbbbbbbbbbbbbb";
const CHANNEL_C = "UCcccccccccccccccccccccc";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-phase2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempDb(t) {
  const dir = tempDir(t);
  const db = new Db(path.join(dir, "wadstube.db"));
  t.after(() => { try { db.close(); } catch {} });
  return { dir, db };
}

async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const active = app.listen(0, "127.0.0.1", () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function video(videoId, channelId, published, options = {}) {
  return {
    video_id: videoId,
    channel_id: channelId,
    title: options.title || videoId,
    description: options.description || "",
    published,
    short_status: options.short_status || "long",
    highlight_reason: options.highlight_reason || null,
  };
}

test("v11 migration preserves reader state and adds return acknowledgement", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "v10.db");
  const seeded = new Db(file);
  seeded.upsertChannel(CHANNEL_A, "Valid channel");
  seeded.upsertVideos([video("valid-video", CHANNEL_A, "2026-01-01")]);
  seeded.setVideoState("valid-video", { watched_at: true });
  seeded.close();

  const legacy = new Database(file);
  legacy.exec(`
    DROP INDEX IF EXISTS idx_video_state_highlight_ack;
    ALTER TABLE video_state DROP COLUMN highlight_acknowledged_at;
    INSERT INTO video_state(video_id, watched_at, updated_at)
    VALUES ('orphan-video', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 10;
  `);
  legacy.close();

  const db = new Db(file);
  t.after(() => db.close());
  assert.equal(db.db.pragma("user_version", { simple: true }), 11);
  assert.equal(
    db.db.prepare("SELECT watched_at FROM video_state WHERE video_id = ?")
      .get("valid-video").watched_at !== null,
    true,
  );
  assert.equal(db.db.prepare("SELECT 1 FROM video_state WHERE video_id = ?")
    .get("orphan-video"), undefined);
  assert.ok(db.db.prepare("PRAGMA table_info(video_state)").all()
    .some((column) => column.name === "highlight_acknowledged_at"));
});

test("return badges, exact scoped IDs, acknowledgement, pagination, and cleanup agree", (t) => {
  const { db } = tempDb(t);
  db.upsertChannel(CHANNEL_A, "Alpha Favorite");
  db.upsertChannel(CHANNEL_B, "Beta");
  db.setChannelFavorite(CHANNEL_A, true);
  db.upsertVideos([
    video("return-new", CHANNEL_A, "2026-06-05T00:00:00.000Z", {
      title: "Needle newest", highlight_reason: "return_after_1_year",
    }),
    video("ordinary", CHANNEL_A, "2026-06-04T00:00:00.000Z"),
    video("return-tie-z", CHANNEL_B, "2026-06-03T00:00:00.000Z", {
      title: "Needle tie z", highlight_reason: "return_after_6_months",
    }),
    video("return-tie-a", CHANNEL_B, "2026-06-03T00:00:00.000Z", {
      title: "Needle tie a", highlight_reason: "return_after_6_months",
    }),
    video("old-prunable", CHANNEL_A, "2026-01-01T00:00:00.000Z", {
      highlight_reason: "return_after_1_year",
    }),
  ]);

  assert.deepEqual(
    db.queryVideos({ view: "returns", limit: 20 }).map((row) => row.video_id),
    ["return-new", "return-tie-z", "return-tie-a", "old-prunable"],
  );
  assert.deepEqual(db.listUnacknowledgedReturns({
    channelIds: [CHANNEL_B], q: "Needle", limit: 1,
  }), { count: 2, videoIds: ["return-tie-z"] });
  assert.deepEqual(db.listUnacknowledgedReturns({
    favorites: true, limit: 20,
  }).videoIds, ["return-new", "old-prunable"]);

  const first = db.queryVideos({ sort: "returning", limit: 1 })[0];
  const secondPage = db.queryVideos({
    sort: "returning",
    before: first.published,
    beforeId: first.video_id,
    beforeReturning: true,
    limit: 20,
  });
  assert.equal(first.video_id, "return-new");
  assert.deepEqual(secondPage.map((row) => row.video_id), [
    "return-tie-z", "return-tie-a", "old-prunable", "ordinary",
  ]);

  const at = "2026-07-19T12:00:00.000Z";
  assert.equal(db.acknowledgeHighlights(["return-new", "ordinary", "missing"], at), 1);
  assert.equal(db.acknowledgeHighlights(["return-new"], at), 0);
  assert.throws(() => db.acknowledgeHighlights(Array(5001).fill("bounded")), /1 to 5000/);
  const acknowledged = db.queryVideos({ channelId: CHANNEL_A, limit: 20 })
    .find((row) => row.video_id === "return-new");
  assert.equal(acknowledged.highlight_reason, null);
  assert.equal(acknowledged.highlight_history_reason, "return_after_1_year");
  assert.equal(acknowledged.highlight_acknowledged_at, at);
  assert.equal(
    db.db.prepare("SELECT highlight_reason FROM videos WHERE video_id = ?")
      .get("return-new").highlight_reason,
    "return_after_1_year",
  );
  assert.equal(db.queryVideos({ view: "returns", limit: 20 })
    .some((row) => row.video_id === "return-new"), false);

  db.setVideoState("old-prunable", { watched_at: true });
  db.pruneChannel(CHANNEL_A, 2);
  assert.equal(db.db.prepare("SELECT 1 FROM videos WHERE video_id = ?")
    .get("old-prunable"), undefined);
  assert.equal(db.db.prepare("SELECT 1 FROM video_state WHERE video_id = ?")
    .get("old-prunable"), undefined);

  db.setVideoState("return-tie-z", { starred_at: true });
  db.setVideoState("return-tie-a", { starred_at: true });
  db.pruneChannel(CHANNEL_B, 1);
  assert.ok(db.db.prepare("SELECT 1 FROM videos WHERE video_id = ?").get("return-tie-z"));
  assert.ok(db.db.prepare("SELECT 1 FROM video_state WHERE video_id = ?").get("return-tie-z"));
  assert.equal(db.db.prepare("SELECT 1 FROM videos WHERE video_id = ?").get("return-tie-a"), undefined);
  assert.equal(db.db.prepare("SELECT 1 FROM video_state WHERE video_id = ?").get("return-tie-a"), undefined);
  db.removeChannel(CHANNEL_A);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM video_state").get().count, 1);
});

test("return routes expose exact bounded IDs and acknowledge explicit IDs idempotently", async (t) => {
  const { db } = tempDb(t);
  db.upsertChannel(CHANNEL_A, "Alpha");
  db.upsertChannel(CHANNEL_B, "Beta");
  db.upsertVideos([
    video("alpha-return", CHANNEL_A, "2026-07-03", {
      title: "Scoped needle", highlight_reason: "return_after_1_year",
    }),
    video("beta-return", CHANNEL_B, "2026-07-02", {
      title: "Scoped needle", highlight_reason: "return_after_6_months",
    }),
  ]);
  const appState = {
    db,
    data: { version: 1, folders: [{
      id: "alpha-folder", name: "Alpha Folder",
      channels: [{ id: CHANNEL_A, name: "Alpha" }], children: [],
    }] },
    smartPolicy: { rules: [] },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/videos", require("../routes/videos")(appState));
  const base = await listen(t, app);

  let response = await fetch(`${base}/api/videos/returns?folder=alpha-folder&q=needle&limit=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 1, videoIds: ["alpha-return"] });
  assert.equal((await fetch(`${base}/api/videos/returns?folder=missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/videos/returns?limit=1.5`)).status, 400);

  const originalListReturns = db.listUnacknowledgedReturns.bind(db);
  db.listUnacknowledgedReturns = () => { throw new Error("injected return-list failure"); };
  response = await fetch(`${base}/api/videos/returns`);
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /injected return-list failure/);
  db.listUnacknowledgedReturns = originalListReturns;

  response = await fetch(`${base}/api/videos?view=returns&folder=alpha-folder`);
  assert.deepEqual((await response.json()).videos.map((row) => row.video_id), ["alpha-return"]);

  db.db.exec(`
    CREATE TRIGGER fail_beta_acknowledgement
    BEFORE INSERT ON video_state WHEN NEW.video_id = 'beta-return'
    BEGIN SELECT RAISE(ABORT, 'injected acknowledgement failure'); END
  `);
  response = await fetch(`${base}/api/videos/returns/acknowledge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoIds: ["alpha-return", "beta-return"] }),
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /injected acknowledgement failure/);
  assert.equal(db.listUnacknowledgedReturns({ limit: 20 }).count, 2);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM video_state").get().count, 0);
  db.db.exec("DROP TRIGGER fail_beta_acknowledgement");

  response = await fetch(`${base}/api/videos/returns/acknowledge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoIds: ["alpha-return"] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requested: 1, acknowledged: 1 });
  response = await fetch(`${base}/api/videos/returns/acknowledge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoIds: ["alpha-return"] }),
  });
  assert.equal((await response.json()).acknowledged, 0);
  response = await fetch(`${base}/api/videos/returns/acknowledge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoIds: ["beta-return", "beta-return"] }),
  });
  assert.equal(response.status, 400);
  assert.equal((await (await fetch(`${base}/api/videos/returns?folder=alpha-folder`)).json()).count, 0);
});

test("bulk move merging is deterministic and rejects ambiguous destination memberships", () => {
  const data = { version: 1, folders: [
    { id: "source", name: "Source", channels: [{
      id: CHANNEL_A, name: "Source name", addedAt: "2020-01-01T00:00:00.000Z",
    }], children: [] },
    { id: "destination", name: "Destination", channels: [{
      id: CHANNEL_A, name: "Destination pinned", addedAt: "2024-01-01T00:00:00.000Z",
      userRenamed: true,
    }], children: [] },
  ] };
  assert.deepEqual(moveChannels(data, "source", "destination", [CHANNEL_A]), {
    moved: [], deduplicated: [CHANNEL_A],
  });
  assert.deepEqual(data.folders[1].channels[0], {
    id: CHANNEL_A,
    name: "Destination pinned",
    addedAt: "2020-01-01T00:00:00.000Z",
    userRenamed: true,
  });

  const ambiguous = { version: 1, folders: [
    { id: "source", name: "Source", channels: [{
      id: CHANNEL_A, name: "Source", addedAt: "2024-01-01T00:00:00.000Z",
    }], children: [] },
    { id: "destination", name: "Destination", channels: [
      { id: CHANNEL_A, name: "One", addedAt: "2024-01-01T00:00:00.000Z" },
      { id: CHANNEL_A, name: "Two", addedAt: "2024-01-02T00:00:00.000Z" },
    ], children: [] },
  ] };
  const before = structuredClone(ambiguous);
  assert.throws(
    () => moveChannels(ambiguous, "source", "destination", [CHANNEL_A]),
    (err) => err.status === 409 && /duplicate memberships/.test(err.message),
  );
  assert.deepEqual(ambiguous, before);
});

test("unresolved replacement is exact, in-place, collision-safe, and API-accounted", async (t) => {
  const { dir, db } = tempDb(t);
  db.upsertChannel(CHANNEL_A, "Existing database title");
  const addedAt = "2020-01-01T00:00:00.000Z";
  const data = { version: 1, folders: [{
    id: "source", name: "Source",
    channels: [
      { id: "legacy-one", name: "Pinned", addedAt, userRenamed: true, unresolved: true },
      { id: "legacy-two", name: "Legacy Two", addedAt, unresolved: true },
      { id: "legacy-three", name: "Legacy Three", addedAt, unresolved: true },
    ],
    children: [],
  }] };

  const collisionData = structuredClone(data);
  collisionData.folders[0].channels.push({ id: CHANNEL_A, name: "Existing", addedAt });
  const beforeCollision = structuredClone(collisionData);
  assert.throws(() => replaceUnresolvedChannel(
    collisionData, "source", "legacy-one",
    { channelId: CHANNEL_A, channelName: "Resolved" },
  ), /already exists/);
  assert.deepEqual(collisionData, beforeCollision);

  const movedData = structuredClone(data);
  movedData.folders.push({ id: "dest", name: "Destination", channels: [], children: [] });
  const moved = moveChannels(movedData, "source", "dest", ["legacy-one"]);
  assert.deepEqual(moved, { moved: ["legacy-one"], deduplicated: [] });
  assert.equal(movedData.folders[1].channels[0].addedAt, addedAt);

  let reservations = 0;
  const appState = {
    data, dataDir: dir, db, apiKey: "test-key", refreshLock: null,
    quota: { reserve(endpoint) {
      reservations++;
      assert.equal(endpoint, "channels.list");
    } },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/folders", require("../routes/folders")(appState));
  const request = global.fetch;
  const base = await listen(t, app);
  let resolverFetches = 0;
  t.mock.method(global, "fetch", async (url) => {
    resolverFetches++;
    assert.match(String(url), /youtube\/v3\/channels/);
    return {
      ok: true,
      async json() {
        return { items: [{ id: CHANNEL_B, snippet: { title: "Resolved Two" } }] };
      },
    };
  });

  let unreadReads = 0;
  const originalUnreadCounts = db.getUnreadCounts.bind(db);
  db.getUnreadCounts = () => {
    unreadReads++;
    throw new Error("ancillary summary read must not run");
  };
  let response = await request(`${base}/api/folders/source/channels/legacy-one/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ urlOrId: CHANNEL_A }),
  });
  assert.equal(response.status, 200);
  const resolvedPayload = await response.json();
  assert.equal(resolvedPayload.folderId, "source");
  assert.equal(resolvedPayload.replacedLegacyId, "legacy-one");
  assert.equal(resolvedPayload.channelId, CHANNEL_A);
  assert.equal(resolvedPayload.channelName, "Pinned");
  assert.equal(Object.hasOwn(resolvedPayload, "folders"), false);
  assert.equal(unreadReads, 0);
  db.getUnreadCounts = originalUnreadCounts;
  assert.equal(reservations, 0);
  assert.deepEqual(appState.data.folders[0].channels[0], {
    id: CHANNEL_A, name: "Pinned", addedAt, userRenamed: true,
  });
  assert.equal(db.getChannelMeta(CHANNEL_A).title, "Existing database title",
    "direct canonical IDs must not replace a known title with Unknown");

  const quotaBeforeRejectedTargets = reservations;
  for (const legacyId of ["missing-legacy", CHANNEL_A]) {
    response = await request(`${base}/api/folders/source/channels/${legacyId}/resolve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ urlOrId: "https://youtube.com/@must-not-resolve" }),
    });
    assert.equal(response.status, legacyId === CHANNEL_A ? 409 : 400);
  }
  assert.equal(resolverFetches, 0, "invalid legacy targets must fail before URL resolution");
  assert.equal(reservations, quotaBeforeRejectedTargets,
    "invalid legacy targets must not consume quota");

  db.db.exec(`
    CREATE TRIGGER fail_channel_c_insert
    BEFORE INSERT ON channels WHEN NEW.id = '${CHANNEL_C}'
    BEGIN SELECT RAISE(ABORT, 'injected database failure'); END
  `);
  response = await request(`${base}/api/folders/source/channels/legacy-three/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ urlOrId: CHANNEL_C }),
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /rolled back/);
  assert.equal(appState.refreshLock, null);
  assert.equal(appState.data.folders[0].channels[2].id, "legacy-three");
  assert.equal(db.getChannelMeta(CHANNEL_C), null);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "tube.json"), "utf8"))
      .folders[0].channels[2].id,
    "legacy-three",
  );
  db.db.exec("DROP TRIGGER fail_channel_c_insert");

  response = await request(`${base}/api/folders/source/channels/legacy-three/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ urlOrId: CHANNEL_C }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).channelName, "Unknown",
    "a genuinely new direct canonical ID has no invented title");
  assert.equal(db.getChannelMeta(CHANNEL_C).title, "Unknown");

  const failureState = {
    data: { version: 1, folders: [{
      id: "failure", name: "Failure",
      channels: [{ id: "legacy-failure", name: "Still here", addedAt, unresolved: true }],
      children: [],
    }] },
    dataDir: path.join(dir, "missing", "directory"),
    db,
    apiKey: "test-key",
    quota: appState.quota,
    refreshLock: null,
  };
  const failureApp = express();
  failureApp.use(express.json());
  failureApp.use("/api/folders", require("../routes/folders")(failureState));
  const failureBase = await listen(t, failureApp);
  response = await request(`${failureBase}/api/folders/failure/channels/legacy-failure/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ urlOrId: CHANNEL_C }),
  });
  assert.equal(response.status, 500);
  assert.equal(failureState.refreshLock, null);
  assert.equal(failureState.data.folders[0].channels[0].id, "legacy-failure");

  response = await request(`${base}/api/folders/source/channels/legacy-two/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://youtube.com/@resolved" }),
  });
  assert.equal(response.status, 200);
  assert.equal(reservations, 1);
  assert.equal(resolverFetches, 1);
  assert.deepEqual(appState.data.folders[0].channels[1], {
    id: CHANNEL_B, name: "Resolved Two", addedAt,
  });
  assert.equal(db.getChannelMeta(CHANNEL_B).title, "Resolved Two");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "tube.json"), "utf8")), appState.data);
});

test("bulk channel actions validate all IDs, use one refresh, preserve moves, and delete globally", async (t) => {
  const { dir, db } = tempDb(t);
  const addedAt = "2024-01-01T00:00:00.000Z";
  const data = { version: 1, folders: [
    { id: "source", name: "Source", channels: [
      { id: CHANNEL_A, name: "A custom", addedAt, userRenamed: true },
      { id: CHANNEL_B, name: "B pinned", addedAt, userRenamed: true },
    ], children: [] },
    { id: "destination", name: "Destination",
      channels: [{ id: CHANNEL_B, name: "B duplicate", addedAt: "2020-01-01T00:00:00.000Z" }], children: [] },
    { id: "other", name: "Other",
      channels: [{ id: CHANNEL_A, name: "A elsewhere", addedAt }], children: [] },
  ] };
  for (const [id, title] of [[CHANNEL_A, "A"], [CHANNEL_B, "B"]]) {
    db.upsertChannel(id, title);
    db.upsertVideos([video(`${title}-video`, id, "2026-07-01", {
      highlight_reason: "return_after_1_year",
    })]);
    db.acknowledgeHighlights([`${title}-video`]);
  }
  let refreshCalls = 0;
  let refreshedIds = null;
  let failRefresh = false;
  const appState = {
    data, dataDir: dir, db, refreshLock: null, apiKey: null, quota: null,
    manualMode: "rss", maxVideos: 50, smartPolicy: { rules: [] },
    refreshIntervalMinutes: 30,
    refreshChannels: async (_db, ids, options) => {
      refreshCalls++;
      refreshedIds = ids;
      if (failRefresh) throw new Error("injected refresh failure");
      return { errors: 0, checked: ids.length, trigger: options.trigger, scope: options.scope };
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/channels", require("../routes/channels")(appState));
  const base = await listen(t, app);
  const jsonRequest = (url, method, body) => fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  let response = await fetch(`${base}/api/channels`);
  let rows = await response.json();
  assert.deepEqual(rows.find((row) => row.id === CHANNEL_A).folderIds.sort(), ["other", "source"]);

  response = await jsonRequest("/api/channels/bulk/refresh", "POST", {
    channelIds: [CHANNEL_A, CHANNEL_B],
  });
  assert.equal(response.status, 200);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(refreshedIds, [CHANNEL_A, CHANNEL_B]);
  assert.equal((await response.json()).summary.trigger, "manual-bulk");

  failRefresh = true;
  response = await jsonRequest("/api/channels/bulk/refresh", "POST", {
    channelIds: [CHANNEL_A],
  });
  assert.equal(response.status, 502);
  assert.equal(appState.refreshLock, null);
  failRefresh = false;

  response = await jsonRequest("/api/channels/bulk/favorite", "PATCH", {
    channelIds: [CHANNEL_A, CHANNEL_B], favorite: true,
  });
  assert.equal(response.status, 200);
  assert.equal(db.getChannelMeta(CHANNEL_A).favorite, 1);
  assert.equal(db.getChannelMeta(CHANNEL_B).favorite, 1);
  response = await jsonRequest("/api/channels/bulk/favorite", "PATCH", {
    channelIds: [CHANNEL_A, CHANNEL_A], favorite: false,
  });
  assert.equal(response.status, 400);
  assert.equal(db.getChannelMeta(CHANNEL_A).favorite, 1);
  response = await jsonRequest("/api/channels/bulk/favorite", "PATCH", {
    channelIds: [CHANNEL_A, CHANNEL_C], favorite: false,
  });
  assert.equal(response.status, 404);
  assert.equal(db.getChannelMeta(CHANNEL_A).favorite, 1, "validation must precede all writes");

  appState.data.folders[0].channels.push({
    id: CHANNEL_A, name: "A duplicate", addedAt: "2025-01-01T00:00:00.000Z",
  });
  const beforeDuplicateMove = JSON.stringify(appState.data);
  response = await jsonRequest("/api/channels/bulk/move", "POST", {
    channelIds: [CHANNEL_A],
    sourceFolderId: "source", destinationFolderId: "destination",
  });
  assert.equal(response.status, 409);
  assert.equal(JSON.stringify(appState.data), beforeDuplicateMove);
  appState.data.folders[0].channels.pop();

  response = await jsonRequest("/api/channels/bulk/move", "POST", {
    channelIds: [CHANNEL_A, CHANNEL_B],
    sourceFolderId: "source", destinationFolderId: "destination",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, moved: 1, deduplicated: 1,
    movedChannelIds: [CHANNEL_A], deduplicatedChannelIds: [CHANNEL_B],
  });
  assert.deepEqual(data.folders[0].channels.map((channel) => channel.id),
    [CHANNEL_A, CHANNEL_B], "the original object must not be mutated");
  assert.deepEqual(appState.data.folders[0].channels, []);
  assert.equal(appState.data.folders[1].channels.find((channel) => channel.id === CHANNEL_A).userRenamed, true);
  assert.deepEqual(appState.data.folders[1].channels.find((channel) => channel.id === CHANNEL_B), {
    id: CHANNEL_B,
    name: "B pinned",
    addedAt: "2020-01-01T00:00:00.000Z",
    userRenamed: true,
  });

  const beforeInvalidMove = JSON.stringify(appState.data);
  response = await jsonRequest("/api/channels/bulk/move", "POST", {
    channelIds: [CHANNEL_A, CHANNEL_B],
    sourceFolderId: "other", destinationFolderId: "source",
  });
  assert.equal(response.status, 400);
  assert.equal(JSON.stringify(appState.data), beforeInvalidMove);

  const beforeFailedDelete = structuredClone(appState.data);
  db.db.exec(`
    CREATE TRIGGER fail_channel_b_delete
    BEFORE DELETE ON channels WHEN OLD.id = '${CHANNEL_B}'
    BEGIN SELECT RAISE(ABORT, 'injected database failure'); END
  `);
  response = await jsonRequest("/api/channels/bulk", "DELETE", {
    channelIds: [CHANNEL_A, CHANNEL_B],
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /rolled back/);
  assert.deepEqual(appState.data, beforeFailedDelete);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, "tube.json"), "utf8")),
    beforeFailedDelete,
  );
  assert.ok(db.getChannelMeta(CHANNEL_A));
  assert.ok(db.getChannelMeta(CHANNEL_B));
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM videos").get().count, 2);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM video_state").get().count, 2);
  assert.equal(appState.refreshLock, null);

  db.db.exec("DROP TRIGGER fail_channel_b_delete");
  response = await jsonRequest("/api/channels/bulk", "DELETE", {
    channelIds: [CHANNEL_A, CHANNEL_B],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, removedChannels: 2, removedMemberships: 3,
  });
  assert.equal(db.getChannelMeta(CHANNEL_A), null);
  assert.equal(db.getChannelMeta(CHANNEL_B), null);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM video_state").get().count, 0);
  assert.equal(appState.data.folders.flatMap((folder) => folder.channels).length, 0);
});
