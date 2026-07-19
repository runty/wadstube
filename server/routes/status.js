const express = require("express");

module.exports = function statusRoutes(appState) {
  const router = express.Router();
  router.get("/quota", (_req, res) => {
    res.json(appState.quota.status());
  });
  router.get("/refresh-runs", (req, res) => {
    res.json(appState.db.listRefreshRuns(req.query.limit));
  });
  router.get("/refresh", (_req, res) => {
    res.json({
      running: !!appState.refreshLock,
      quota: appState.quota.status(),
      recentRuns: appState.db.listRefreshRuns(10),
    });
  });
  return router;
};
