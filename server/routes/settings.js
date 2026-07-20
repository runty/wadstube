const express = require("express");
const { validatePolicy } = require("../lib/refresh-policy");
const { SMART_REFRESH_POLICY_KEY } = require("../lib/settings");

module.exports = function settingsRoutes(appState) {
  const router = express.Router();

  function candidatePolicy(body) {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !Object.hasOwn(body, "policy")) {
      throw new Error("policy object required");
    }
    const partial = body.policy;
    if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
      throw new Error("policy must be a JSON object");
    }
    const baseline = appState.defaultSmartPolicy;
    return {
      noHistoryIntervalHours: Object.hasOwn(partial, "noHistoryIntervalHours")
        ? partial.noHistoryIntervalHours
        : baseline.noHistoryIntervalHours,
      newUploadCooldownHours: Object.hasOwn(partial, "newUploadCooldownHours")
        ? partial.newUploadCooldownHours
        : baseline.newUploadCooldownHours,
      failureRetryMinutes: Object.hasOwn(partial, "failureRetryMinutes")
        ? partial.failureRetryMinutes
        : baseline.failureRetryMinutes,
      rules: Object.hasOwn(partial, "rules") ? partial.rules : baseline.rules,
    };
  }

  router.get("/smart-refresh", (_req, res) => {
    res.json({
      policy: appState.smartPolicy,
      source: appState.smartPolicySource || "environment",
      defaultPolicy: appState.defaultSmartPolicy,
    });
  });

  router.put("/smart-refresh", (req, res) => {
    let policy;
    try {
      policy = validatePolicy(candidatePolicy(req.body));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      appState.db.setSetting(SMART_REFRESH_POLICY_KEY, policy);
    } catch (err) {
      return res.status(500).json({ error: `Failed to save smart refresh policy: ${err.message}` });
    }
    appState.smartPolicy = policy;
    appState.smartPolicySource = "persisted";
    return res.json({ ok: true, policy, source: "persisted" });
  });

  router.delete("/smart-refresh", (_req, res) => {
    try {
      appState.db.deleteSetting(SMART_REFRESH_POLICY_KEY);
    } catch (err) {
      return res.status(500).json({ error: `Failed to delete smart refresh policy: ${err.message}` });
    }
    appState.smartPolicy = appState.defaultSmartPolicy;
    appState.smartPolicySource = "environment";
    return res.json({ ok: true, policy: appState.smartPolicy, source: "environment" });
  });

  return router;
};
