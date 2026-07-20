const {
  collectAllChannels,
  findFolder,
  isResolvedChannel,
} = require("./data");
const { isRssFallbackErrorCode } = require("./refresh");
const { evaluateRefresh, validatePolicy } = require("./refresh-policy");

// YouTube's playlistItems.list refresh request costs one general unit per
// channel. Keep the counterfactual estimate explicit instead of inferring it
// from whichever mode happens to be configured for the next run.
const API_REFRESH_UNITS_PER_CHANNEL = 1;

function apiRefreshUnitsForChannels(channelCount) {
  return Math.max(0, Number(channelCount) || 0) * API_REFRESH_UNITS_PER_CHANNEL;
}

function membershipsForScope(data, folderId = null) {
  if (folderId !== null) {
    const folder = findFolder(data.folders, folderId);
    if (!folder) throw new Error(`Folder "${folderId}" not found`);
    return collectAllChannels(folder);
  }
  return (data.folders || []).flatMap((folder) => collectAllChannels(folder));
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function chooseMode(manualMode, quota, channelCount) {
  const requestedMode = manualMode;
  if (requestedMode !== "api" || !quota) {
    return { requestedMode, mode: requestedMode, fallbackReason: null };
  }
  try {
    // This is a read-only budget assertion. Actual quota is reserved only by
    // the refresh worker after POST recomputes and starts the run.
    quota.assertCanSpend("general", apiRefreshUnitsForChannels(channelCount));
    return { requestedMode, mode: requestedMode, fallbackReason: null };
  } catch (err) {
    if (!isRssFallbackErrorCode(err.code)) throw err;
    return { requestedMode, mode: "rss", fallbackReason: err.code };
  }
}

function quotaSnapshot(quota) {
  return quota?.status?.() || null;
}

function buildRefreshPlan(appState, { folderId = null, now = new Date() } = {}) {
  // The stored policy is normally validated on load/update. Validate at the
  // planner boundary too so corrupted or programmatically supplied state can
  // never overflow interval arithmetic or Date serialization.
  const policy = validatePolicy(appState.smartPolicy);
  const memberships = membershipsForScope(appState.data, folderId);
  const resolvedMemberships = memberships.filter(isResolvedChannel);
  const unresolvedCount = memberships.length - resolvedMemberships.length;
  const channelIds = [...new Set(resolvedMemberships.map((channel) => channel.id))];
  const metadata = new Map(
    appState.db.listChannelRefreshMeta(channelIds).map((row) => [row.id, row]),
  );
  const channelPlans = channelIds.map((channelId) => {
    const evaluation = evaluateRefresh(metadata.get(channelId) || {}, {
      now,
      policy,
      baseIntervalMinutes: 0,
    });
    return {
      channel_id: channelId,
      due: evaluation.due,
      reason: evaluation.reason,
      next_due_at: evaluation.nextDueAt,
      interval_hours: evaluation.intervalHours ?? null,
    };
  });
  const dueChannelIds = channelPlans.filter((plan) => plan.due)
    .map((plan) => plan.channel_id);
  const skippedPlans = channelPlans.filter((plan) => !plan.due);
  const dueByReason = Object.create(null);
  const skippedByReason = Object.create(null);
  for (const plan of channelPlans) {
    increment(plan.due ? dueByReason : skippedByReason, plan.reason);
  }
  if (unresolvedCount) skippedByReason.unresolved = unresolvedCount;
  const nextDueAt = skippedPlans.map((plan) => plan.next_due_at)
    .filter(Boolean).sort()[0] || null;
  const runMode = chooseMode(appState.manualMode, appState.quota, dueChannelIds.length);
  const quota = quotaSnapshot(appState.quota);
  const general = quota?.buckets?.general || null;
  const allMemberships = membershipsForScope(appState.data, null);
  const fullPassChannels = new Set(
    allMemberships.filter(isResolvedChannel).map((channel) => channel.id),
  ).size;
  const remaining = general?.remaining ?? null;

  return {
    scope: folderId === null ? "all" : folderId,
    memberships: {
      total: memberships.length,
      resolved: resolvedMemberships.length,
      unresolved: unresolvedCount,
    },
    channels: {
      total: channelIds.length,
      due: dueChannelIds.length,
      skipped: skippedPlans.length,
      dueIds: dueChannelIds,
      plans: channelPlans,
      dueByReason,
      skippedByReason,
      nextDueAt,
    },
    mode: {
      requested: runMode.requestedMode,
      effective: runMode.mode,
      fallbackReason: runMode.fallbackReason,
    },
    projectedApiUnits:
      runMode.requestedMode === "api" ? apiRefreshUnitsForChannels(dueChannelIds.length) : 0,
    quota,
    fullPass: {
      channelCount: fullPassChannels,
      projectedApiUnits: apiRefreshUnitsForChannels(fullPassChannels),
      currentRemaining: remaining,
      canCover: remaining === null ? null : remaining >= fullPassChannels,
      completePassesRemaining:
        remaining === null || fullPassChannels === 0
          ? null
          : Math.floor(remaining / fullPassChannels),
    },
  };
}

function serializeRefreshPlan(plan) {
  return {
    scope: plan.scope,
    membership_count: plan.memberships.total,
    resolved_membership_count: plan.memberships.resolved,
    unique_channel_count: plan.channels.total,
    unresolved_count: plan.memberships.unresolved,
    due_count: plan.channels.due,
    skipped_count: plan.memberships.unresolved + plan.channels.skipped,
    due_by_reason: plan.channels.dueByReason,
    skipped_by_reason: plan.channels.skippedByReason,
    next_due_at: plan.channels.nextDueAt,
    due_channel_ids: plan.channels.dueIds,
    channel_plans: plan.channels.plans,
    requested_mode: plan.mode.requested,
    effective_mode: plan.mode.effective,
    fallback_reason: plan.mode.fallbackReason,
    projected_required_api_units: plan.projectedApiUnits,
    quota: plan.quota,
    full_pass: {
      channel_count: plan.fullPass.channelCount,
      projected_api_units: plan.fullPass.projectedApiUnits,
      current_remaining: plan.fullPass.currentRemaining,
      can_cover: plan.fullPass.canCover,
      complete_passes_remaining: plan.fullPass.completePassesRemaining,
    },
  };
}

module.exports = {
  buildRefreshPlan,
  serializeRefreshPlan,
  membershipsForScope,
  chooseMode,
  apiRefreshUnitsForChannels,
};
