const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const Db = require("../lib/db");
const { saveData } = require("../lib/data");
const { restoreData } = require("../lib/restore");
const { tryAcquireLock, refreshChannels } = require("../lib/refresh");
const { fetchBuffered } = require("../lib/fetch");
const { resolveUrl, fetchChannelViaApi } = require("../lib/youtube");
const CHANNEL = "UCaaaaaaaaaaaaaaaaaaaaaa";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wadstube-fixes-"));
  const db = new Db(path.join(dir, "wadstube.db"));
  db.upsertChannel(CHANNEL, "Original");
  db.upsertVideos([{ video_id: "original-video", channel_id: CHANNEL, title: "Original video", published: "2025-01-01", short_status: "long" }]);
  db.setVideoState("original-video", { starred_at: true, watched_at: true });
  const data = { version: 1, folders: [{ id: "original", name: "Original", children: [], channels: [{ id: CHANNEL, name: "Original" }] }] };
  saveData(dir, data);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dataDir: dir, data, db, refreshLock: null };
}

for (const operation of ["writeFileSync", "renameSync", "purgeOrphanChannels"]) {
  test(`restore ${operation} failure preserves memory, JSON, SQLite, and snapshot`, async t => {
    const state = fixture(t);
    const previous = state.data;
    if (operation === "purgeOrphanChannels") {
      // Abort inside the real transaction after deleting video rows.
      state.db.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON channels BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END;");
    } else {
      const original = fs[operation];
      t.mock.method(fs, operation, (...args) => {
        if (args[0] === path.join(state.dataDir, "tube.json.tmp")) throw new Error("injected save failure");
        return original(...args);
      });
    }
    let snapshot;
    await assert.rejects(restoreData(state, { version: 1, folders: [] }), err => {
      snapshot = err.restoreSnapshot;
      return /injected/.test(err.message);
    });
    assert.equal(state.data, previous);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.dataDir, "tube.json"))), previous);
    assert.equal(state.db.getChannelMeta(CHANNEL).title, "Original");
    assert.equal(state.db.queryVideos({ view: "starred" })[0].watched, true);
    assert.ok(fs.existsSync(path.join(state.dataDir, snapshot, "wadstube.db")));
    assert.equal(state.refreshLock, null);
    assert.equal(state.recoveryRequired, undefined);
  });
}

test("failed restore compensation blocks further lock-taking operations", async t => {
  const state = fixture(t);
  t.mock.method(state.db, "purgeOrphanChannels", () => { throw new Error("purge failed"); });
  const rename = fs.renameSync;
  let publications = 0;
  t.mock.method(fs, "renameSync", (...args) => {
    if (args[1] === path.join(state.dataDir, "tube.json") && ++publications === 2) throw new Error("rollback failed");
    return rename(...args);
  });
  await assert.rejects(restoreData(state, { version: 1, folders: [] }), /file rollback failed/);
  assert.match(state.recoveryRequired, /^pre-restore-/);
  assert.equal(state.data.folders[0].id, "original");
  assert.throws(() => tryAcquireLock(state), err => err.status === 503);
});

test("complete-response deadlines stop stalled headers/bodies and oversized decoded bodies", async t => {
  const server = http.createServer((req, res) => {
    if (req.url === "/headers") return;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.flushHeaders();
    if (req.url === "/large") return res.end("x".repeat(2048));
    if (req.url === "/slow") {
      const timer = setInterval(() => res.write("x"), 10);
      res.on("close", () => clearInterval(timer));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const suffix of ["/headers", "/body", "/slow"]) {
    const start = Date.now();
    await assert.rejects(fetchBuffered(base + suffix, {}, { timeout: 80 }), /abort|timed out/i);
    assert.ok(Date.now() - start < 1500);
  }
  await assert.rejects(fetchBuffered(base + "/large", {}, { maxBytes: 1024 }), /exceeds 1024/);
});

test("discarded retry bodies are cancelled without waiting for their payload", async t => {
  let cancelled = false;
  t.mock.method(global, "fetch", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 }));
  const result = await fetchBuffered("https://example.invalid", {}, { discardErrors: true });
  assert.equal(result.response.status, 503);
  assert.equal(cancelled, true);
});

test("international handles and encoded tab URLs use exact lookup; invalid syntax never fetches", async t => {
  let handles = [];
  t.mock.method(global, "fetch", async url => {
    handles.push(new URL(url).searchParams.get("forHandle"));
    return Response.json({ items: [{ id: CHANNEL, snippet: { title: "International" } }] });
  });
  for (const input of ["@日本語", "@%E6%97%A5%E6%9C%AC%E8%AA%9E/videos", "@café/", "@한국어/shorts"]) {
    assert.equal((await resolveUrl("test-key", `https://www.youtube.com/${input}`)).channelId, CHANNEL);
  }
  assert.deepEqual(handles, ["@日本語", "@日本語", "@café", "@한국어"]);
  for (const url of ["https://youtube.com/@%ZZ", "https://youtube.com/@bad%2Fname", "https://youtube.com/@bad%00name", "ftp://youtube.com/@name", "https://notyoutube.com/@name", "https://youtu.be/@name"]) {
    await assert.rejects(resolveUrl("test-key", url), err => err.code === "invalidInput");
  }
  assert.equal(handles.length, 4);
});

test("video publication dates replace playlist dates and update existing rows without losing reader state", async t => {
  const state = fixture(t);
  state.db.upsertVideos([{ video_id: "dated", channel_id: CHANNEL, title: "Before", published: "2026-09-01", short_status: "long" }]);
  state.db.setVideoState("dated", { starred_at: true, watched_at: true });
  t.mock.method(global, "fetch", async url => {
    assert.equal(new URL(url).searchParams.get("part"), "snippet,contentDetails");
    return Response.json({ items: [
      { snippet: { resourceId: { videoId: "dated" }, publishedAt: "2026-09-01", title: "Correct" }, contentDetails: { videoPublishedAt: "2025-01-02T03:04:05Z" } },
      { snippet: { resourceId: { videoId: "missing" }, publishedAt: "2026-09-01" } },
      { snippet: { resourceId: { videoId: "invalid" } }, contentDetails: { videoPublishedAt: "bad" } },
    ] });
  });
  const result = await fetchChannelViaApi("test-key", CHANNEL);
  assert.equal(result.videos.length, 1);
  state.db.upsertVideos(result.videos);
  state.db.setLatestUploadAt(CHANNEL, "2026-09-01");
  state.db.setLatestUploadAt(CHANNEL, result.videos[0].published, { recompute: true });
  assert.equal(state.db.getChannelMeta(CHANNEL).latest_upload_at, "2025-01-02T03:04:05.000Z");
  const row = state.db.queryVideos({ view: "starred" })[0];
  assert.equal(row.published, "2025-01-02T03:04:05.000Z");
  assert.equal(row.watched, true);
  assert.equal(row.starred, true);
});

test("refresh streams deliver delayed events after a POST body completes", async t => {
  const interval = global.setInterval;
  t.mock.method(global, "setInterval", (callback, ms, ...args) => interval(callback, ms === 15000 ? 5 : ms, ...args));
  const state = fixture(t);
  state.manualMode = "rss";
  state.refreshChannels = async (_db, _ids, _opts, emit) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    emit({ type: "done", channelId: CHANNEL, status: "ok" });
    return { checked: 1, updated: 1, new_videos: 0, errors: 0 };
  };
  const app = express();
  app.use(express.json());
  app.use("/api/refresh", require("../routes/refresh")(state));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(response.status, 200);
  assert.ok(events.some(event => event.type === "done"));
  assert.ok(events.some(event => event.type === "heartbeat"));
  assert.ok(events.some(event => event.type === "summary"));
  assert.equal(state.refreshLock, null);
});

test("real refresh emits its durable run id before completion", async t => {
  const state = fixture(t);
  const events = [];
  const summary = await refreshChannels(state.db, [], {}, event => events.push(event));
  assert.equal(events[0].type, "run");
  assert.equal(events[0].run_id, summary.run_id);
  assert.equal(state.db.listRefreshRuns(1)[0].status, "complete");
});
