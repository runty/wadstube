const express = require("express");
const router = express.Router();

module.exports = function (appState) {
  const {
    getFolderTreeSummary,
    createFolder,
    renameFolder,
    deleteFolder,
    addChannel,
    removeChannel,
    getChannelList,
    saveData,
  } = require("../lib/data");
  const { resolveUrl } = require("../lib/youtube");

  function save() {
    saveData(appState.dataDir, appState.data);
  }

  function summary() {
    return getFolderTreeSummary(appState.data);
  }

  function validateFolderName(name) {
    if (!name || typeof name !== "string" || !name.trim()) return false;
    if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
    if (name.trim().length > 100) return false;
    return true;
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
      createFolder(appState.data, name.trim(), parent?.trim() || null);
      save();
      res.json({ ok: true, folders: summary() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /api/folders/:name — rename
  router.patch("/:name", (req, res) => {
    try {
      const { newName } = req.body;
      if (!validateFolderName(newName)) return res.status(400).json({ error: "Invalid folder name" });
      renameFolder(appState.data, req.params.name, newName.trim());
      save();
      res.json({ ok: true, folders: summary() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/folders/:name
  router.delete("/:name", (req, res) => {
    try {
      deleteFolder(appState.data, req.params.name);
      save();
      res.json({ ok: true, folders: summary() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/folders/:name/channels
  router.get("/:name/channels", (req, res) => {
    try {
      const channels = getChannelList(appState.data, req.params.name);
      res.json(channels);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // POST /api/folders/:name/channels — add channel
  router.post("/:name/channels", async (req, res) => {
    try {
      let { channelId, url } = req.body;
      let channelName;

      if (url && !channelId) {
        const resolved = await resolveUrl(appState.apiKey, url);
        channelId = resolved.channelId;
        channelName = resolved.channelTitle;
      }

      if (!channelId) return res.status(400).json({ error: "channelId or url required" });

      addChannel(appState.data, req.params.name, channelId, channelName);
      save();
      res.json({ ok: true, channelId, channelName, folders: summary() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/folders/:name/channels/:channelId
  router.delete("/:name/channels/:channelId", (req, res) => {
    try {
      removeChannel(appState.data, req.params.name, req.params.channelId);
      save();
      res.json({ ok: true, folders: summary() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
