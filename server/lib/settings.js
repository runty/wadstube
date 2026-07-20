const { validatePolicy } = require("./refresh-policy");

const SMART_REFRESH_POLICY_KEY = "smart_refresh_policy";

function loadSmartRefreshPolicy(db, defaultPolicy, logger = console) {
  try {
    const stored = db.getSetting(SMART_REFRESH_POLICY_KEY);
    if (stored === null) return { policy: defaultPolicy, source: "environment" };
    return { policy: validatePolicy(stored), source: "persisted" };
  } catch (err) {
    logger.warn?.(`[settings] invalid persisted smart refresh policy; using environment default: ${err.message}`);
    return { policy: defaultPolicy, source: "environment" };
  }
}

module.exports = { SMART_REFRESH_POLICY_KEY, loadSmartRefreshPolicy };
