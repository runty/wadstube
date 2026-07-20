<script>
  import { onMount } from "svelte";
  import ModalShell from "./ModalShell.svelte";
  import { showOperations, toast } from "../stores/feed.js";
  import {
    draftToPolicy,
    createLatestRequest,
    formatBytes,
    formatBackupLastSuccess,
    formatDuration,
    loadBackups as fetchBackups,
    loadQuotaForecast as fetchQuotaForecast,
    loadQuotaHistory as fetchQuotaHistory,
    loadOperationsTab,
    loadSmartPolicy,
    loadSystemStatus as fetchSystemStatus,
    nextRuleId,
    policyToDraft,
    quotaBarPercent,
    resetSmartPolicy,
    runDatabaseCheck as requestDatabaseCheck,
    saveSmartPolicy,
    systemVideoCounts,
    verifyBackup as requestBackupVerification,
  } from "../stores/operations.js";

  const tabs = [
    { id: "rules", label: "Refresh rules" },
    { id: "quota", label: "Quota" },
    { id: "system", label: "System" },
    { id: "backups", label: "Backups" },
  ];
  let activeTab = "rules";

  let payload = null, draft = null, rulesLoading = true, saving = false;
  let rulesError = "", validation = "";

  let historyDays = 30, quotaHistory = null, quotaForecast = null;
  let historyLoading = false, forecastLoading = false;
  let historyError = "", forecastError = "";

  let systemStatus = null, systemLoading = false, systemError = "";
  let databaseChecking = false, databaseCheck = null, databaseCheckError = "";

  let backups = null, backupsLoading = false, backupsError = "";
  let verification = {};
  const loadedTabs = new Set();
  const latestHistory = createLatestRequest();
  const latestForecast = createLatestRequest();
  const latestSystem = createLatestRequest();
  const latestBackups = createLatestRequest();

  $: quotaCurrent = quotaHistory?.current || quotaForecast?.current || null;
  $: generalCurrent = quotaCurrent?.buckets?.general || null;
  $: searchCurrent = quotaCurrent?.buckets?.search || null;
  $: systemVideos = systemVideoCounts(systemStatus?.database);
  $: historyRows = (quotaHistory?.history || []).map((day) => ({
    quotaDay: day.quotaDay,
    units: day.buckets?.general?.units || 0,
    calls: day.buckets?.general?.calls || 0,
    limit: day.buckets?.general?.limit || 0,
    searchUnits: day.buckets?.search?.units || 0,
    searchCalls: day.buckets?.search?.calls || 0,
    percent: quotaBarPercent(day.buckets?.general),
  }));

  const close = () => showOperations.set(false);

  function formatDate(value, includeTime = true) {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return includeTime ? date.toLocaleString() : date.toLocaleDateString();
  }

  function selectTab(id, focus = false) {
    activeTab = id;
    ensureTabLoaded(id);
    if (focus) queueMicrotask(() => document.getElementById(`operations-tab-${id}`)?.focus());
  }

  function tabKeydown(event, index) {
    let next = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    selectTab(tabs[next].id, true);
  }

  async function loadRules() {
    rulesLoading = true; rulesError = "";
    try { payload = await loadSmartPolicy(); draft = policyToDraft(payload.policy); }
    catch (err) { rulesError = err.message; }
    finally { rulesLoading = false; }
  }

  async function loadHistory() {
    historyLoading = true; historyError = ""; quotaHistory = null;
    const days = historyDays;
    return latestHistory(
      (signal) => fetchQuotaHistory(days, { signal }),
      {
        success: (value) => { quotaHistory = value; },
        error: (err) => { historyError = err.message; },
        settled: () => { historyLoading = false; },
      },
    );
  }

  async function loadForecast() {
    forecastLoading = true; forecastError = ""; quotaForecast = null;
    return latestForecast(
      (signal) => fetchQuotaForecast({ signal }),
      {
        success: (value) => { quotaForecast = value; },
        error: (err) => { forecastError = err.message; },
        settled: () => { forecastLoading = false; },
      },
    );
  }

  function refreshQuota() { loadHistory(); loadForecast(); }

  async function loadSystem() {
    systemLoading = true; systemError = "";
    return latestSystem(
      (signal) => fetchSystemStatus({ signal }),
      {
        success: (value) => { systemStatus = value; },
        error: (err) => { systemError = err.message; },
        settled: () => { systemLoading = false; },
      },
    );
  }

  async function loadBackupList() {
    backupsLoading = true; backupsError = "";
    return latestBackups(
      (signal) => fetchBackups(30, { signal }),
      {
        success: (value) => { backups = value; },
        error: (err) => { backupsError = err.message; },
        settled: () => { backupsLoading = false; },
      },
    );
  }

  function ensureTabLoaded(id) {
    return loadOperationsTab(id, loadedTabs, {
      rules: loadRules,
      quotaHistory: loadHistory,
      quotaForecast: loadForecast,
      system: loadSystem,
      backups: loadBackupList,
    });
  }

  onMount(() => {
    ensureTabLoaded(activeTab);
  });

  function updateRule(index, field, value) {
    draft.rules[index] = { ...draft.rules[index], [field]: value };
    draft = { ...draft, rules: [...draft.rules] };
  }
  function addRule() {
    const id = nextRuleId(draft.rules);
    const suffix = id.replace("custom_rule_", "");
    draft = { ...draft, rules: [...draft.rules, { id, label: `Custom rule ${suffix}`, minUploadAgeDays: "30", minRefreshIntervalHours: "6" }] };
  }
  function removeRule(index) { draft = { ...draft, rules: draft.rules.filter((_, i) => i !== index) }; }

  async function save() {
    validation = ""; rulesError = ""; let policy;
    try { policy = draftToPolicy(draft); } catch (err) { validation = err.message; return; }
    saving = true;
    try {
      payload = await saveSmartPolicy(policy); draft = policyToDraft(payload.policy);
      toast.set({ message: "Refresh rules saved", type: "success" });
    } catch (err) { rulesError = err.message; }
    finally { saving = false; }
  }

  async function reset() {
    if (!confirm("Reset refresh rules to the environment defaults?")) return;
    saving = true; validation = ""; rulesError = "";
    try { payload = await resetSmartPolicy(); draft = policyToDraft(payload.policy); toast.set({ message: "Refresh rules reset", type: "success" }); }
    catch (err) { rulesError = err.message; }
    finally { saving = false; }
  }

  async function checkDatabase() {
    databaseChecking = true; databaseCheck = null; databaseCheckError = "";
    try { databaseCheck = await requestDatabaseCheck(); }
    catch (err) { databaseCheckError = err.message; }
    finally { databaseChecking = false; }
  }

  async function verify(date) {
    verification = { ...verification, [date]: { loading: true, data: null, error: "" } };
    try {
      const data = await requestBackupVerification(date);
      verification = { ...verification, [date]: { loading: false, data, error: "" } };
      toast.set({ message: `Backup ${date} verified`, type: "success" });
    } catch (err) {
      verification = { ...verification, [date]: { loading: false, data: null, error: err.message } };
    }
  }
</script>

<ModalShell id="operations-panel" title="Operations" onClose={close} wide>
  <p slot="subtitle">Refresh policy, API usage, system health, and verified backups.</p>

  <div class="tabs" role="tablist" aria-label="Operations sections">
    {#each tabs as tab, index}
      <button
        id={`operations-tab-${tab.id}`}
        type="button"
        role="tab"
        aria-selected={activeTab === tab.id}
        aria-controls={`operations-panel-${tab.id}`}
        tabindex={activeTab === tab.id ? 0 : -1}
        class:active={activeTab === tab.id}
        on:click={() => selectTab(tab.id)}
        on:keydown={(event) => tabKeydown(event, index)}
      >{tab.label}</button>
    {/each}
  </div>

  {#if activeTab === "rules"}
    <div class="tab-panel" id="operations-panel-rules" role="tabpanel" aria-labelledby="operations-tab-rules">
      {#if rulesLoading}<p role="status">Loading settings…</p>
      {:else if !draft}<p class="alert" role="alert">{rulesError || "Settings unavailable"}</p>
      {:else}
        <div class="section-title"><div><h3>Smart refresh rules</h3><p>Source: <strong>{payload?.source || "unknown"}</strong></p></div></div>
        <div class="base-grid">
          <label>No upload history (hours)<input type="number" min="0.01" step="0.25" bind:value={draft.noHistoryIntervalHours} /></label>
          <label>After a new upload (hours)<input type="number" min="0.01" step="0.25" bind:value={draft.newUploadCooldownHours} /></label>
          <label class="wide-field">Failure retries (minutes, comma separated)<input bind:value={draft.failureRetryMinutes} /></label>
        </div>
        <h4>Inactivity rules</h4>
        <div class="rule-head" aria-hidden="true"><span>ID and label</span><span>Upload age days</span><span>Minimum hours</span><span></span></div>
        {#each draft.rules as rule, index (rule.id + index)}
          <div class="rule-row">
            <div><label>ID<input value={rule.id} on:input={(event) => updateRule(index, "id", event.currentTarget.value)} /></label><label>Label<input value={rule.label} on:input={(event) => updateRule(index, "label", event.currentTarget.value)} /></label></div>
            <label>Age<input type="number" min="0" value={rule.minUploadAgeDays} on:input={(event) => updateRule(index, "minUploadAgeDays", event.currentTarget.value)} /></label>
            <label>Hours<input type="number" min="0.01" step="0.25" value={rule.minRefreshIntervalHours} on:input={(event) => updateRule(index, "minRefreshIntervalHours", event.currentTarget.value)} /></label>
            <button type="button" on:click={() => removeRule(index)} aria-label={`Remove ${rule.label || rule.id}`}>Remove</button>
          </div>
        {/each}
        <button type="button" on:click={addRule}>+ Add rule</button>
        {#if validation}<p class="alert" role="alert">{validation}</p>{/if}
        {#if rulesError}<p class="alert" role="alert">{rulesError}</p>{/if}
      {/if}
    </div>
  {:else if activeTab === "quota"}
    <div class="tab-panel" id="operations-panel-quota" role="tabpanel" aria-labelledby="operations-tab-quota">
      <div class="section-title split">
        <div><h3>YouTube API quota</h3><p>Usage days follow {quotaHistory?.timezone || quotaForecast?.timezone || "America/Los_Angeles"}.</p></div>
        <div class="quota-controls">
          <label>History
            <select bind:value={historyDays} on:change={loadHistory} disabled={historyLoading}>
              <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
            </select>
          </label>
          <button type="button" on:click={refreshQuota} disabled={historyLoading || forecastLoading}>{historyLoading || forecastLoading ? "Refreshing…" : "Refresh quota"}</button>
        </div>
      </div>

      {#if generalCurrent}
        <div class="metric-grid">
          <div><span>Used today</span><strong>{generalCurrent.used?.toLocaleString() ?? "?"}</strong></div>
          <div><span>Remaining</span><strong>{generalCurrent.remaining?.toLocaleString() ?? "?"}</strong></div>
          <div><span>Daily limit</span><strong>{generalCurrent.limit?.toLocaleString() ?? "?"}</strong></div>
          <div><span>Handle searches</span><strong>{searchCurrent?.used?.toLocaleString() ?? 0} / {searchCurrent?.limit?.toLocaleString() ?? "?"}</strong></div>
          <div><span>Resets</span><strong class="small-value">{formatDate(quotaCurrent.resetAt)}</strong></div>
        </div>
      {/if}

      <div class="dashboard-grid">
        <article class="dashboard-card wide-card">
          <div class="card-heading"><div><h4>General-unit history</h4><p>Daily calls and charged units.</p></div>{#if historyLoading}<span role="status">Updating…</span>{/if}</div>
          {#if historyError}<p class="alert" role="alert">History unavailable: {historyError}</p>
          {:else if !historyRows.length && !historyLoading}<p class="muted">No history returned.</p>
          {:else}
            <div class="history-table" role="table" aria-label="Daily YouTube API quota history">
              {#each historyRows as row}
                <div class="history-row" role="row">
                  <span role="cell">{row.quotaDay}</span>
                  <div class="bar-track" role="cell" aria-label={`${row.units} of ${row.limit} units`}><span style={`width:${row.percent}%`}></span></div>
                  <span role="cell">{row.units.toLocaleString()} units</span>
                  <span role="cell">{row.calls.toLocaleString()} calls</span>
                  <span role="cell">Search: {row.searchCalls.toLocaleString()} calls / {row.searchUnits.toLocaleString()} units</span>
                </div>
              {/each}
            </div>
          {/if}
        </article>

        <article class="dashboard-card">
          <h4>Complete-day average</h4>
          {#if forecastError}<p class="alert" role="alert">Forecast unavailable: {forecastError}</p>
          {:else if forecastLoading}<p role="status">Loading estimate…</p>
          {:else if quotaForecast?.completeDayAverage}
            <p class="big-number">{quotaForecast.completeDayAverage.buckets?.general?.averageUnits?.toLocaleString() ?? 0}<span> units/day</span></p>
            <p>Handle searches average {quotaForecast.completeDayAverage.buckets?.search?.averageCalls?.toLocaleString() ?? 0} calls / {quotaForecast.completeDayAverage.buckets?.search?.averageUnits?.toLocaleString() ?? 0} units per day.</p>
            <p>Based only on {quotaForecast.completeDayAverage.days} complete days, {quotaForecast.completeDayAverage.startDay} through {quotaForecast.completeDayAverage.endDay}.</p>
          {:else}<p class="muted">No complete-day average available.</p>{/if}
        </article>

        <article class="dashboard-card">
          <h4>Current eligibility snapshot</h4>
          {#if quotaForecast?.snapshot}
            <p>Generated {formatDate(quotaForecast.generatedAt)}.</p>
            <p class="big-number">{quotaForecast.snapshot.dueChannels.toLocaleString()}<span> channels due now</span></p>
            <p>{quotaForecast.snapshot.expectedApiUnitsIfRunNow.toLocaleString()} API units expected. Mode: {quotaForecast.snapshot.requestedMode.toUpperCase()} requested → {quotaForecast.snapshot.effectiveMode.toUpperCase()} effective.</p>
            <p>API mode would require {quotaForecast.snapshot.apiUnitsRequiredForApiMode.toLocaleString()} units.</p>
            {#if quotaForecast.snapshot.fallbackReason}<p class="notice">Fallback: {quotaForecast.snapshot.fallbackReason}</p>{/if}
          {:else if !forecastLoading && !forecastError}<p class="muted">No snapshot available.</p>{/if}
        </article>

        <article class="dashboard-card wide-card snapshot-note">
          <h4>Full-pass capacity</h4>
          {#if quotaForecast?.snapshot?.fullPass}
            <p><strong>{quotaForecast.snapshot.fullPass.completePassesRemaining ?? "Unknown"}</strong> complete passes remaining at the current quota balance. A full pass is {quotaForecast.snapshot.fullPass.channelCount.toLocaleString()} channels / {quotaForecast.snapshot.fullPass.projectedApiUnits.toLocaleString()} units.</p>
            <p>The current balance <strong>{quotaForecast.snapshot.fullPass.canCover ? "can" : "cannot"}</strong> cover one full API pass.</p>
          {/if}
          <p><strong>Snapshot only:</strong> this is current eligibility and quota arithmetic, not a time forecast. New uploads, failures, manual actions, and YouTube responses can change the result.</p>
        </article>
      </div>
    </div>
  {:else if activeTab === "system"}
    <div class="tab-panel" id="operations-panel-system" role="tabpanel" aria-labelledby="operations-tab-system">
      <div class="section-title split"><div><h3>System health</h3><p>Cheap runtime status{systemStatus?.checkedAt ? ` checked ${formatDate(systemStatus.checkedAt)}` : ""}; integrity checks run only when requested.</p></div><button type="button" on:click={loadSystem} disabled={systemLoading}>{systemLoading ? "Refreshing…" : "Refresh status"}</button></div>
      {#if systemError}<p class="alert" role="alert">System status unavailable: {systemError}</p>{/if}
      {#if systemLoading && !systemStatus}<p role="status">Loading system status…</p>
      {:else if systemStatus}
        <div class="metric-grid">
          <div><span>Version</span><strong>{systemStatus.version}</strong></div>
          <div><span>Uptime</span><strong>{formatDuration(systemStatus.process?.uptimeSeconds)}</strong></div>
          <div><span>Channels</span><strong>{systemStatus.database?.channelCount?.toLocaleString() ?? "?"}</strong></div>
          <div><span>Videos stored</span><strong>{systemVideos.total?.toLocaleString() ?? "?"}</strong></div>
          <div><span>Visible videos</span><strong>{systemVideos.visible?.toLocaleString() ?? "?"}</strong></div>
        </div>
        <div class="dashboard-grid">
          <article class="dashboard-card"><h4>Process & refresh</h4>
            <dl><div><dt>Started</dt><dd>{formatDate(systemStatus.process?.startedAt)}</dd></div><div><dt>Refresh</dt><dd>{systemStatus.refresh?.locked ? "Running" : "Idle"}</dd></div><div><dt>Active tasks</dt><dd>{systemStatus.refresh?.activeTasks ?? 0}</dd></div><div><dt>Modes</dt><dd>{systemStatus.refresh?.defaultMode} default / {systemStatus.refresh?.manualMode} manual</dd></div><div><dt>Interval</dt><dd>{systemStatus.refresh?.intervalMinutes ? `${systemStatus.refresh.intervalMinutes} minutes` : "Manual only"}</dd></div><div><dt>Policy</dt><dd>{systemStatus.refresh?.policySource}</dd></div></dl>
          </article>
          <article class="dashboard-card"><h4>Database & storage</h4>
            <dl><div><dt>Database</dt><dd>{formatBytes(systemStatus.database?.databaseBytes)}</dd></div><div><dt>WAL</dt><dd>{formatBytes(systemStatus.database?.walBytes)}</dd></div><div><dt>Total</dt><dd>{formatBytes(systemStatus.database?.totalBytes)}</dd></div><div><dt>Journal</dt><dd>{systemStatus.database?.journalMode?.toUpperCase() || "Unknown"}</dd></div></dl>
            <button type="button" on:click={checkDatabase} disabled={databaseChecking}>{databaseChecking ? "Checking…" : "Run database integrity check"}</button>
            <div class="action-status" aria-live="polite">
              {#if databaseCheckError}<p class="alert">Check failed: {databaseCheckError}</p>
              {:else if databaseCheck}<p class:good={databaseCheck.ok} class="notice">{databaseCheck.ok ? "Integrity check passed" : `Integrity check reported ${databaseCheck.result || "a problem"}`} · {databaseCheck.durationMs?.toLocaleString() ?? "?"} ms · {formatDate(databaseCheck.checkedAt)}</p>{/if}
            </div>
          </article>
          <article class="dashboard-card"><h4>Subscriptions</h4>
            <dl><div><dt>Memberships</dt><dd>{systemStatus.subscriptions?.memberships?.toLocaleString() ?? "?"}</dd></div><div><dt>Resolved</dt><dd>{systemStatus.subscriptions?.resolvedMemberships?.toLocaleString() ?? "?"}</dd></div><div><dt>Unresolved</dt><dd>{systemStatus.subscriptions?.unresolvedMemberships?.toLocaleString() ?? "?"}</dd></div><div><dt>Unique channels</dt><dd>{systemStatus.subscriptions?.uniqueResolvedChannels?.toLocaleString() ?? "?"}</dd></div></dl>
          </article>
          <article class="dashboard-card"><h4>Nightly backup</h4>
            <dl><div><dt>Schedule</dt><dd>{systemStatus.backup?.scheduled ? "Scheduled" : "Stopped"}{systemStatus.backup?.running ? " / running" : ""}</dd></div><div><dt>Next run</dt><dd>{formatDate(systemStatus.backup?.nextRunAt)}</dd></div><div><dt>Last success</dt><dd>{formatBackupLastSuccess(systemStatus.backup?.lastSuccessAt, formatDate)}</dd></div><div><dt>Last failure</dt><dd>{formatDate(systemStatus.backup?.lastFailureAt)}</dd></div></dl>
            {#if systemStatus.backup?.lastError}<p class="alert">{systemStatus.backup.lastError}</p>{/if}
          </article>
        </div>
      {/if}
    </div>
  {:else}
    <div class="tab-panel" id="operations-panel-backups" role="tabpanel" aria-labelledby="operations-tab-backups">
      <div class="section-title split"><div><h3>Backup snapshots</h3><p>{backups?.count ?? 0} listed. Verification reads both files and runs SQLite quick_check. It never restores data.</p></div><button type="button" on:click={loadBackupList} disabled={backupsLoading}>{backupsLoading ? "Refreshing…" : "Refresh list"}</button></div>
      {#if backupsError}<p class="alert" role="alert">Backup list unavailable: {backupsError}</p>{/if}
      {#if backupsLoading && !backups}<p role="status">Loading backups…</p>
      {:else if backups && !backups.backups?.length}<p class="muted">No complete backup snapshots found.</p>
      {:else if backups}
        <div class="backup-list">
          {#each backups.backups as backup (backup.date)}
            <article class="backup-row">
              <div><h4>{backup.date}</h4><p>Modified {formatDate(backup.modifiedAt)} · {formatBytes(backup.totalBytes)}</p><p>Subscriptions {formatBytes(backup.files?.["tube.json"]?.bytes)} · Database {formatBytes(backup.files?.["wadstube.db"]?.bytes)}</p></div>
              <button type="button" on:click={() => verify(backup.date)} disabled={verification[backup.date]?.loading}>{verification[backup.date]?.loading ? "Verifying…" : "Verify backup"}</button>
              <div class="verify-status" aria-live="polite">
                {#if verification[backup.date]?.error}<p class="alert">Verification failed: {verification[backup.date].error}</p>
                {:else if verification[backup.date]?.data}<p class="notice good">Verified {formatDate(verification[backup.date].data.verifiedAt)} · SQLite {verification[backup.date].data.quickCheck} · {verification[backup.date].data.normalizationRepairs} normalization repairs</p>{/if}
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <svelte:fragment slot="footer">
    <button type="button" on:click={close}>Close</button>
    {#if activeTab === "rules"}
      <button type="button" on:click={reset} disabled={saving || rulesLoading}>Reset defaults</button>
      <button class="primary" type="button" on:click={save} disabled={saving || rulesLoading || !draft}>{saving ? "Saving…" : "Save rules"}</button>
    {/if}
  </svelte:fragment>
</ModalShell>

<style>
  .tabs { display:flex; gap:5px; overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; padding-bottom:12px; border-bottom:1px solid var(--border); }
  .tabs button { white-space:nowrap; }
  .tabs button.active { background:var(--accent); color:var(--ink); border-color:var(--accent); }
  .tab-panel { padding-top:14px; }
  h3,h4 { color:var(--heading); margin:0 0 8px; } h4{font-size:.9rem} p{color:var(--text-muted);font-size:.8rem;margin:3px 0;line-height:1.45}
  .section-title { margin-bottom:12px; } .section-title.split,.card-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .quota-controls{display:flex;align-items:end;gap:7px}.quota-controls label{min-width:110px}
  .base-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; } .wide-field{grid-column:1/-1}
  label { display:grid; gap:4px; color:var(--text-muted); font-size:.76rem; }
  input,select { background:var(--field); color:var(--text); border:1px solid var(--border); border-radius:7px; padding:8px; min-width:0; }
  .rule-head,.rule-row { display:grid; grid-template-columns:minmax(240px,2fr) 1fr 1fr auto; gap:8px; align-items:end; padding:8px 0; border-bottom:1px solid var(--border); }
  .rule-head{color:var(--text-muted);font-size:.7rem}.rule-row>div{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  button { background:var(--button);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:8px 11px;cursor:pointer;font:inherit }
  button:disabled { opacity:.55; cursor:not-allowed; } button.primary{background:var(--accent);color:var(--ink);border-color:var(--accent)}
  .alert{color:var(--danger);margin-top:10px;overflow-wrap:anywhere}.muted{color:var(--text-muted)}
  .notice { padding:8px; border-radius:7px; background:rgb(var(--accent-rgb) / .1); overflow-wrap:anywhere; }
  .notice.good,.good { color:var(--heading); background:rgb(var(--accent-rgb) / .1); }
  .metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(125px,1fr)); gap:8px; margin-bottom:12px; }
  .metric-grid>div { padding:12px; border:1px solid var(--border); background:var(--button); border-radius:9px; min-width:0; }
  .metric-grid span,.metric-grid strong { display:block; } .metric-grid span{color:var(--text-muted);font-size:.7rem}.metric-grid strong{color:var(--heading);font-size:1.2rem;margin-top:4px;overflow-wrap:anywhere}.metric-grid .small-value{font-size:.78rem;line-height:1.4}
  .dashboard-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .dashboard-card { border:1px solid var(--border); background:var(--card-bg); border-radius:9px; padding:13px; min-width:0; }
  .wide-card { grid-column:1/-1; } .big-number{font-size:1.55rem;color:var(--heading);font-weight:700}.big-number span{font-size:.8rem;color:var(--text-muted);font-weight:400}
  .history-table { display:grid; gap:7px; max-height:300px; overflow:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; padding-right:4px; }
  .history-row { display:grid; grid-template-columns:90px minmax(100px,1fr) 80px 70px minmax(145px,auto); align-items:center; gap:8px; color:var(--text-muted); font-size:.72rem; }
  .bar-track { height:9px; background:var(--button); border-radius:999px; overflow:hidden; } .bar-track span { display:block; height:100%; min-width:1px; background:var(--accent); border-radius:inherit; }
  dl { margin:0 0 10px; } dl div { display:flex; justify-content:space-between; gap:12px; padding:5px 0; border-bottom:1px solid var(--border); font-size:.76rem; } dt{color:var(--text-muted)}dd{margin:0;color:var(--heading);text-align:right;overflow-wrap:anywhere}
  .action-status { min-height:20px; margin-top:7px; }
  .backup-list { display:grid; gap:9px; }
  .backup-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px 14px; align-items:center; padding:12px; border:1px solid var(--border); border-radius:9px; }
  .backup-row h4 { margin-bottom:2px; } .verify-status { grid-column:1/-1; min-height:0; }
  @media(max-width:700px){
    .base-grid,.rule-row,.dashboard-grid,.metric-grid{grid-template-columns:1fr 1fr}.wide-field,.wide-card{grid-column:1/-1}.rule-head{display:none}.rule-row>div{grid-template-columns:1fr}.metric-grid .small-value{font-size:.72rem}
    .history-row{grid-template-columns:78px minmax(70px,1fr) 75px minmax(120px,auto)}.history-row span:nth-child(4){display:none}.section-title.split{align-items:stretch;flex-direction:column}.quota-controls{align-items:stretch}.quota-controls label{flex:1}
  }
  @media(max-width:480px){.base-grid,.rule-row,.dashboard-grid,.metric-grid{grid-template-columns:1fr}.wide-field,.wide-card{grid-column:auto}.backup-row{grid-template-columns:1fr}.backup-row>button{justify-self:start}.verify-status{grid-column:auto}}
</style>
