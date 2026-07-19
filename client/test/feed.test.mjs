import test from "node:test";
import assert from "node:assert/strict";
import { get } from "svelte/store";

const loc = { pathname: "/", search: "" };
globalThis.location = loc;
globalThis.window = {
  location: loc,
  innerWidth: 1200,
  addEventListener() {},
  removeEventListener() {},
  scrollTo() {},
};
globalThis.history = { pushState() {}, replaceState() {} };

const feed = await import("../src/stores/feed.js");
const channelDisplay = await import("../src/lib/channel-display.js");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("return-first sort is restored from the URL", () => {
  loc.search = "?sort=returning";
  feed.initializeUrlState();
  assert.equal(get(feed.sortOrder), "returning");
  loc.search = "";
  feed.sortOrder.set("newest");
});

test("cleared and superseded channel loads cannot repopulate stale cache", async () => {
  feed.clearChannelLists();
  const pending = [];
  globalThis.fetch = () => new Promise((resolve) => pending.push(resolve));

  const clearedLoad = feed.loadChannels("folder-a", true);
  await Promise.resolve();
  feed.clearChannelLists();
  pending.shift()(json([{ id: "old" }]));
  await clearedLoad;
  assert.deepEqual(get(feed.channelLists), {});

  const older = feed.loadChannels("folder-a", true);
  await Promise.resolve();
  const newer = feed.loadChannels("folder-a", true);
  await Promise.resolve();
  const resolveOlder = pending.shift();
  const resolveNewer = pending.shift();
  resolveNewer(json([{ id: "new" }]));
  await newer;
  resolveOlder(json([{ id: "stale" }]));
  await older;
  assert.equal(get(feed.channelLists)["folder-a"][0].id, "new");
});

test("manual refresh and channel retry reload unread badges", async () => {
  feed.clearChannelLists();
  feed.channelLists.set({ "folder-a": [{ id: "channel-a", unreadCount: 1 }] });
  feed.activeFolder.set("folder-a");
  feed.activeChannelId.set(null);
  let unread = 4;
  let quotaLoads = 0;
  let historyLoads = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "/api/refresh/folder-a" && options.method === "POST") {
      return new Response('{"type":"init","total":1}\n{"type":"summary","new_videos":1,"errors":0}\n', {
        status: 200, headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    if (value === "/api/channels/channel-a/refresh" && options.method === "POST") {
      unread = 7;
      return json({ ok: true, summary: { errors: 0 } });
    }
    if (value === "/api/folders") return json([{ id: "folder-a", unreadCount: unread, children: [] }]);
    if (value === "/api/folders/folder-a/channels") return json([{ id: "channel-a", unreadCount: unread }]);
    if (value.startsWith("/api/channels?")) return json([]);
    if (value.startsWith("/api/videos")) return json({ videos: [], hasMore: false });
    if (value === "/api/status/quota") {
      quotaLoads++;
      return json({ buckets: { general: { remaining: 9999 } } });
    }
    if (value.startsWith("/api/status/refresh-runs")) {
      historyLoads++;
      return json([]);
    }
    throw new Error(`Unexpected fetch ${value}`);
  };

  await feed.refreshFolder("folder-a");
  assert.equal(get(feed.folders)[0].unreadCount, 4);
  assert.equal(get(feed.channelLists)["folder-a"][0].unreadCount, 4);
  await feed.retryChannel("channel-a");
  assert.equal(get(feed.folders)[0].unreadCount, 7);
  assert.equal(get(feed.channelLists)["folder-a"][0].unreadCount, 7);
  assert.ok(quotaLoads >= 2, "manual refresh and retry both reload quota status");
  assert.ok(historyLoads >= 2, "manual refresh and retry both reload run history");
});

test("deleting a folder clears the active channel", async () => {
  feed.activeFolder.set("folder-a");
  feed.activeChannelId.set("channel-a");
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "/api/folders/folder-a" && options.method === "DELETE") {
      return json({ folders: [] });
    }
    if (value === "/api/videos") return json({ videos: [], hasMore: false });
    throw new Error(`Unexpected fetch ${value}`);
  };
  await feed.deleteFolderApi("folder-a");
  assert.equal(get(feed.activeFolder), "__all__");
  assert.equal(get(feed.activeChannelId), null);
});

test("subscription import reset clears stale navigation and reloads feed", async () => {
  feed.activeFolder.set("folder-old");
  feed.activeChannelId.set("channel-old");
  feed.searchQuery.set("stale query");
  feed.channelLists.set({ "folder-old": [{ id: "channel-old" }] });
  let folderLoads = 0;
  let videoLoads = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === "/api/folders") { folderLoads++; return json([]); }
    if (value === "/api/videos") { videoLoads++; return json({ videos: [], hasMore: false }); }
    throw new Error(`Unexpected fetch ${value}`);
  };
  await feed.resetAfterSubscriptionImport();
  assert.equal(get(feed.activeFolder), "__all__");
  assert.equal(get(feed.activeChannelId), null);
  assert.equal(get(feed.searchQuery), "");
  assert.deepEqual(get(feed.channelLists), {});
  assert.equal(folderLoads, 1);
  assert.equal(videoLoads, 1);
});

test("successful retry is not reported failed when ancillary reloads fail", async () => {
  feed.clearChannelLists();
  feed.activeFolder.set("__all__");
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "/api/channels/channel-a/refresh" && options.method === "POST") {
      return json({ ok: true, summary: { api_units: 1 } });
    }
    if (value === "/api/status/quota") throw new Error("status temporarily unavailable");
    if (value.startsWith("/api/channels?")) return json([]);
    if (value === "/api/folders") return json([]);
    if (value.startsWith("/api/videos")) return json({ videos: [], hasMore: false });
    if (value.startsWith("/api/status/refresh-runs")) return json([]);
    throw new Error(`Unexpected fetch ${value}`);
  };
  assert.deepEqual(await feed.retryChannel("channel-a"), { api_units: 1 });
});

test("failed retry still reloads quota and refresh reports", async () => {
  feed.clearChannelLists();
  let quotaLoads = 0;
  let runLoads = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "/api/channels/channel-a/refresh" && options.method === "POST") {
      return json({ error: "refresh rejected" }, 503);
    }
    if (value === "/api/status/quota") { quotaLoads++; return json({}); }
    if (value.startsWith("/api/status/refresh-runs")) { runLoads++; return json([]); }
    if (value.startsWith("/api/channels?")) return json([]);
    if (value === "/api/folders") return json([]);
    if (value.startsWith("/api/videos")) return json({ videos: [], hasMore: false });
    throw new Error(`Unexpected fetch ${value}`);
  };
  await assert.rejects(() => feed.retryChannel("channel-a"), /refresh rejected/);
  assert.equal(quotaLoads, 1);
  assert.equal(runLoads, 1);
});

test("subscription import remains successful when post-import reload fails", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.deepEqual(await feed.resetAfterSubscriptionImport(), { reloadFailures: 2 });
});

test("unresolved subscriptions have an explicit non-filterable UI state", () => {
  const unresolved = { id: "https://www.youtube.com/c/legacy", unresolved: true };
  assert.equal(channelDisplay.isUnresolvedChannel(unresolved), true);
  assert.equal(channelDisplay.canUseAsFeedFilter(unresolved), false);
  assert.equal(channelDisplay.UNRESOLVED_CHANNEL_LABEL, "Needs resolution");
  assert.match(channelDisplay.UNRESOLVED_CHANNEL_HELP, /Skipped during refresh/);
  assert.equal(channelDisplay.canUseAsFeedFilter({ id: "UCaaaaaaaaaaaaaaaaaaaaaa" }), true);

  for (const reserved of ["__proto__", "constructor"]) {
    const channel = { id: reserved, unresolved: true };
    assert.deepEqual(channelDisplay.ownValue({}, reserved, []), []);
    assert.equal(channelDisplay.moveDestinationFor(new Map(), channel), "");
    const selections = new Map([[reserved, "destination"]]);
    assert.equal(channelDisplay.moveDestinationFor(selections, channel), "destination");
  }
  assert.equal(Object.prototype.destination, undefined);
});

test("reserved-key folder cache lookups never read or mutate object prototypes", async () => {
  feed.clearChannelLists();
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return json([{ id: String(url).includes("constructor") ? "constructor" : "__proto__", unresolved: true }]);
  };
  const prototypeRows = await feed.loadChannels("__proto__");
  const constructorRows = await feed.loadChannels("constructor");
  assert.equal(calls, 2);
  assert.equal(prototypeRows[0].id, "__proto__");
  assert.equal(constructorRows[0].id, "constructor");
  const cache = get(feed.channelLists);
  assert.equal(Object.hasOwn(cache, "__proto__"), true);
  assert.equal(Object.hasOwn(cache, "constructor"), true);
  assert.equal(Object.getPrototypeOf(cache), Object.prototype);
  assert.equal(Object.prototype.unresolved, undefined);
});
