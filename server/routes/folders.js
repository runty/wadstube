const express = require("express");

module.exports = function (appState) {
  const router = express.Router();
  const { rateLimit } = require("../lib/security");
  const {
    getFolderTreeSummary,
    createFolder,
    renameFolder,
    deleteFolder,
    addChannel,
    removeChannel,
    getChannelList,
    renameChannel,
    moveChannel,
    saveData,
    allReferencedChannelIds,
    isResolvedChannel,
    resolveFolderRouteId,
  } = require("../lib/data");

  // After mutations that may remove channels from the tree, drop their
  // rows from the DB so queryVideos doesn't surface ghost subscriptions.
  function purgeOrphans() {
    const referenced = allReferencedChannelIds(appState.data);
    const removed = appState.db.purgeOrphanChannels(referenced);
    if (removed > 0) {
      console.log(`Purged ${removed} orphan channel(s) from the DB`);
    }
  }
  const { resolveUrl, httpStatusForYoutubeError } = require("../lib/youtube");
  const { acquireLockWhenIdle, releaseLock } = require("../lib/refresh");
  const channelAddLimit = rateLimit({
    windowMs: 60_000,
    max: 30,
    name: "channel addition",
  });

  function save() {
    saveData(appState.dataDir, appState.data);
  }

  async function whileRefreshIdle(action) {
    const handle = await acquireLockWhenIdle(appState);
    try {
      return action();
    } finally {
      releaseLock(appState, handle);
    }
  }

  function summary() {
    const unread = appState.db.getUnreadCounts();
    const unreadFor = (channelId) => Object.hasOwn(unread, channelId)
      ? Number(unread[channelId]) || 0
      : 0;
    function enrich(summaryFolder, dataFolder) {
      const children = summaryFolder.children.map((child, index) =>
        enrich(child, dataFolder.children[index]),
      );
      const uniqueChannelIds = new Set();
      function collect(folder) {
        for (const channel of folder.channels || []) {
          if (isResolvedChannel(channel)) uniqueChannelIds.add(channel.id);
        }
        for (const child of folder.children || []) collect(child);
      }
      collect(dataFolder);
      return {
        ...summaryFolder,
        unreadCount: [...uniqueChannelIds].reduce(
          (total, channelId) => total + unreadFor(channelId),
          0,
        ),
        children,
      };
    }
    return getFolderTreeSummary(appState.data).map((folder, index) =>
      enrich(folder, appState.data.folders[index]),
    );
  }

  function validateFolderName(name) {
    if (!name || typeof name !== "string" || !name.trim()) return false;
    if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
    if (name.trim().length > 100) return false;
    return true;
  }

  function resolveFolderId(identifier, res) {
    const resolved = resolveFolderRouteId(appState.data, identifier);
    if (resolved.legacyName) {
      res.setHeader("Deprecation", "true");
      res.setHeader("Warning", '299 - "Folder-name routes are deprecated; use immutable folder IDs"');
    }
    return resolved.id;
  }

  // GET /api/folders
  router.get("/", (req, res) => {
    res.json(summary());
  });

  // POST /api/folders — create
  router.post("/", (req, res) => {
    try {
      const { name, parent } = req.body;
      if (!validateFolderName(name)) return res.status(400).json({ error: "Invalid folder name" });
      const parentId = parent?.trim() ? resolveFolderId(parent.trim(), res) : null;
      createFolder(appState.data, name.trim(), parentId);
      save();
      res.json({ ok: true, folders: summary() });
    } catch (err) {
      res.status(httpStatusForYoutubeError(err, 400)).json({ error: err.message });
    }
  });

  // PATCH /api/folders/:name — rename
  router.patch("/:name", (req, res) => {
    try {
      const { newName } = req.body;
      if (!validateFolderName(newName)) return res.status(400).json({ error: "Invalid folder name" });
      renameFolder(appState.data, resolveFolderId(req.params.name, res), newName.trim());
      save();
      res.json({ ok: true, folders: summary() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/folders/:name
  router.delete("/:name", async (req, res) => {
    try {
      await whileRefreshIdle(() => {
        deleteFolder(appState.data, resolveFolderId(req.params.name, res));
        save();
        purgeOrphans();
      });
      res.json({ ok: true, folders: summary() });
    } catch (err) {
      res.status(httpStatusForYoutubeError(err, 400)).json({ error: err.message });
    }
  });

  // GET /api/folders/:name/channels
  router.get("/:name/channels", (req, res) => {
    try {
      const channels = getChannelList(appState.data, resolveFolderId(req.params.name, res));
      const unread = appState.db.getUnreadCounts();
      const unreadFor = (channelId) => Object.hasOwn(unread, channelId)
        ? Number(unread[channelId]) || 0
        : 0;
      const enriched = channels.map((channel) => {
        const meta = isResolvedChannel(channel)
          ? appState.db.getChannelMeta(channel.id) || {}
          : {};
        return {
          ...channel,
          favorite: !!meta.favorite,
          unreadCount: isResolvedChannel(channel) ? unreadFor(channel.id) : 0,
          last_checked_at: meta.last_checked_at || null,
          last_success_at: meta.last_success_at || null,
          last_refresh_status: meta.last_refresh_status || null,
          last_error: meta.last_error || null,
        };
      }).sort((a, b) => Number(b.favorite) - Number(a.favorite) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      res.json(enriched);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // POST /api/folders/:name/channels — add channel
  router.post("/:name/channels", channelAddLimit, async (req, res) => {
    try {
      let { channelId, url } = req.body;
      let channelName;

      if (url && !channelId) {
        const resolved = await resolveUrl(appState.apiKey, url, { quota: appState.quota });
        channelId = resolved.channelId;
        channelName = resolved.channelTitle;
      }

      if (!channelId) return res.status(400).json({ error: "channelId or url required" });

      const folderId = resolveFolderId(req.params.name, res);
      addChannel(appState.data, folderId, channelId, channelName);
      if (!appState.db.getChannelMeta(channelId)) {
        appState.db.upsertChannel(channelId, channelName || "Unknown");
      }
      save();
      res.json({ ok: true, channelId, channelName, folders: summary() });
    } catch (err) {
      res.status(httpStatusForYoutubeError(err, 400)).json({ error: err.message });
    }
  });

  // DELETE /api/folders/:name/channels/:channelId
  router.delete("/:name/channels/:channelId", async (req, res) => {
    try {
      await whileRefreshIdle(() => {
        removeChannel(appState.data, resolveFolderId(req.params.name, res), req.params.channelId);
        save();
        purgeOrphans();
      });
      res.json({ ok: true, folders: summary() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /api/folders/:name/channels/:channelId — rename channel
  router.patch("/:name/channels/:channelId", (req, res) => {
    try {
      const { name: newName } = req.body;
      if (!newName || typeof newName !== "string" || !newName.trim()) {
        return res.status(400).json({ error: "Channel name is required" });
      }
      if (newName.trim().length > 200) {
        return res.status(400).json({ error: "Channel name too long" });
      }
      renameChannel(appState.data, resolveFolderId(req.params.name, res), req.params.channelId, newName.trim());
      save();
      res.json({ ok: true, name: newName.trim() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/folders/:name/channels/:channelId/move — move channel to another folder
  router.post("/:name/channels/:channelId/move", (req, res) => {
    try {
      const { destFolder } = req.body;
      if (!destFolder || typeof destFolder !== "string") {
        return res.status(400).json({ error: "destFolder is required" });
      }
      const sourceId = resolveFolderId(req.params.name, res);
      const destinationId = resolveFolderId(destFolder, res);
      moveChannel(appState.data, sourceId, req.params.channelId, destinationId);
      save();
      res.json({ ok: true, folders: summary() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
