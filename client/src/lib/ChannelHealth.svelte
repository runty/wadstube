<script>
  import { onMount } from "svelte";
  import {
    channelHealth, healthFilter, showHealth, loadChannelHealth,
    retryChannel, deleteChannel, error, toast, quotaStatus, refreshRuns,
    loadQuotaStatus, loadRefreshRuns,
  } from "../stores/feed.js";
  import { rssFallbackSuffix } from "./refresh-report.js";

  let panel;
  let closeButton;
  let previouslyFocused;
  let retrying = null;
  let deleting = null;

  onMount(() => {
    previouslyFocused = document.activeElement;
    closeButton?.focus();
    Promise.all([loadChannelHealth(), loadQuotaStatus(), loadRefreshRuns()])
      .catch((err) => error.set(err.message));
    return () => previouslyFocused?.focus?.();
  });

  function close() { showHealth.set(false); }
  function keydown(event) {
    if (event.key === "Escape") close();
    if (event.key !== "Tab") return;
    const focusable = [...panel.querySelectorAll("button, select, [href], [tabindex]:not([tabindex='-1'])")]
      .filter((node) => !node.disabled);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  async function changeFilter() {
    try { await loadChannelHealth($healthFilter); } catch (err) { error.set(err.message); }
  }
  async function retry(channel) {
    retrying = channel.id;
    try {
      const summary = await retryChannel(channel.id);
      toast.set({
        message: `Refreshed ${channel.title}${rssFallbackSuffix(summary)} · ${summary?.checked ?? 0} channels checked · ${summary?.api_units || 0} API units this refresh · ${summary?.quota?.buckets?.general?.used ?? "?"} API units used today`,
        type: "success",
        durationMs: 10_000,
      });
    } catch (err) {
      error.set(err.message);
      loadChannelHealth($healthFilter).catch(() => {});
    }
    finally { retrying = null; }
  }
  async function remove(channel) {
    if (!confirm(`Delete ${channel.title} from every folder? Its cached videos and channel refresh state will also be removed.`)) return;
    deleting = channel.id;
    try {
      await deleteChannel(channel.id);
      toast.set({ message: `Deleted ${channel.title} from all folders`, type: "success" });
    } catch (err) {
      error.set(err.message);
    } finally {
      deleting = null;
    }
  }
  function age(value) {
    if (!value) return "Never";
    const hours = Math.floor((Date.now() - new Date(value).getTime()) / 3600000);
    if (hours < 1) return "Less than an hour ago";
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
  function until(value) {
    if (!value) return "unknown";
    const minutes = Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 60000));
    if (minutes < 60) return `in ${minutes}m`;
    if (minutes < 2880) return `in ${Math.ceil(minutes / 60)}h`;
    return `in ${Math.ceil(minutes / 1440)}d`;
  }
</script>

<button class="backdrop" aria-label="Close channel health" on:click={close}></button>
<div class="panel" role="dialog" aria-modal="true" aria-labelledby="health-title"
  tabindex="-1" bind:this={panel} on:keydown={keydown}>
  <header>
    <div><h2 id="health-title">Channel health</h2><p>Last refresh results for subscribed channels.</p></div>
    <button class="close" bind:this={closeButton} on:click={close} aria-label="Close channel health">×</button>
  </header>
  <div class="filters">
    <label for="health-filter">Show</label>
    <select id="health-filter" bind:value={$healthFilter} on:change={changeFilter}>
      <option value="all">All channels</option>
      <option value="error">Errors</option>
      <option value="stale">Not checked in 24 hours</option>
    </select>
    <span>{$channelHealth.length} channels</span>
  </div>
  {#if $quotaStatus?.buckets?.general}
    <section class="quota" aria-label="YouTube API quota">
      <strong>YouTube API today</strong>
      <span>{$quotaStatus.buckets.general.used.toLocaleString()} / {$quotaStatus.buckets.general.limit.toLocaleString()} general units</span>
      <span>{$quotaStatus.buckets.search.used.toLocaleString()} / {$quotaStatus.buckets.search.limit.toLocaleString()} search calls</span>
      <span>Resets {new Date($quotaStatus.resetAt).toLocaleString()}</span>
    </section>
  {/if}
  <div class="rows">
    {#if !$channelHealth.length}<p class="empty">No channels match this filter.</p>{/if}
    {#each $channelHealth as channel (channel.id)}
      <article class:error-row={channel.last_refresh_status === "error"}>
        <div class="name">{channel.favorite ? "★ " : ""}{channel.title}</div>
        <div class="meta">
          <span>{channel.last_refresh_status || "Never refreshed"}</span>
          <span>Attempt {age(channel.last_refresh_attempt_at)}</span>
          <span>Success {age(channel.last_refreshed_at)}</span>
          <span>{channel.smart_refresh?.due ? "Due now" : `Next ${until(channel.smart_refresh?.nextDueAt)}`}</span>
          {#if channel.smart_refresh?.rule}<span>{channel.smart_refresh.rule.label}</span>{/if}
        </div>
        {#if channel.last_error}<p class="err">{channel.last_error}</p>{/if}
        <div class="actions">
          <button on:click={() => retry(channel)} disabled={retrying === channel.id || deleting === channel.id}>
            {retrying === channel.id ? "Refreshing…" : "Retry now"}
          </button>
          <button class="delete" on:click={() => remove(channel)} disabled={retrying === channel.id || deleting === channel.id}>
            {deleting === channel.id ? "Deleting…" : "Delete"}
          </button>
        </div>
      </article>
    {/each}
  </div>
  <section class="history" aria-label="Recent refresh reports">
    <h3>Recent refreshes</h3>
    {#if !$refreshRuns.length}<p class="empty">No refresh history yet.</p>{/if}
    {#each $refreshRuns.slice(0, 10) as run (run.id)}
      <div class="run">
        <strong>{run.trigger} · {run.requested_mode || run.mode}{run.effective_mode && run.effective_mode !== (run.requested_mode || run.mode) ? ` → ${run.effective_mode}` : ""} · {run.status}</strong>
        <span>{new Date(run.started_at).toLocaleString()}</span>
        <span>{run.checked} checked · {run.skipped} skipped · {run.new_videos} new · {run.errors} errors</span>
        <span>{run.api_units} API units ({run.api_calls} calls) · {run.rss_requests} RSS · {run.shorts_probes} Shorts probes · {run.daily_remaining ?? "?"} left</span>
        {#if run.rss_fallbacks > 0}<span>{run.rss_fallbacks} RSS fallback{run.rss_fallbacks === 1 ? "" : "s"}{run.fallback_reason ? ` · ${run.fallback_reason}` : ""}</span>{/if}
        <span>{run.pending_unknown_total || 0} unknown Shorts · {run.pending_reclassified || 0} reclassified</span>
        {#if run.error}<span class="run-error">{run.error}</span>{/if}
      </div>
    {/each}
  </section>
</div>

<style>
  .backdrop { position: fixed; inset: 0; border: 0; background: var(--overlay); z-index: 250; }
  .panel { position: fixed; z-index: 260; top: 6vh; bottom: 6vh; left: 50%; transform: translateX(-50%); width: min(760px, 94vw); background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); display: flex; flex-direction: column; overflow: hidden; }
  header, .filters { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  h2 { color: var(--heading); font-size: 1.2rem; }
  header p, .filters span { color: var(--text-muted); font-size: .82rem; }
  .close { margin-left: auto; border: 0; background: transparent; color: var(--text); font-size: 1.6rem; padding: 4px 10px; }
  select, article button { background: var(--button); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 7px 10px; }
  .filters span { margin-left: auto; }
  .rows { overflow: auto; padding: 10px; }
  .quota { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 10px 18px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: .78rem; }
  .quota strong { color: var(--heading); }
  article { position: relative; padding: 12px 195px 12px 12px; border-bottom: 1px solid var(--border); min-height: 70px; }
  article.error-row { border-left: 3px solid var(--danger); }
  .actions { position: absolute; right: 10px; top: 16px; display: flex; gap: 6px; }
  article button { cursor: pointer; }
  article button.delete { color: var(--danger); border-color: var(--danger); }
  .name { color: var(--heading); font-weight: 700; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--text-muted); font-size: .78rem; }
  .err { color: var(--danger); font-size: .78rem; overflow-wrap: anywhere; }
  .empty { text-align: center; color: var(--text-muted); padding: 40px; }
  .history { padding: 12px 18px; border-top: 1px solid var(--border); max-height: 220px; overflow: auto; }
  .history h3 { color: var(--heading); font-size: .95rem; margin-bottom: 6px; }
  .run { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 7px 0; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: .74rem; }
  .run strong { color: var(--heading); }
  .run-error { grid-column: 1 / -1; color: var(--danger); overflow-wrap: anywhere; }
  @media (max-width: 620px) {
    article { padding-right: 12px; padding-bottom: 54px; }
    .actions { top: auto; bottom: 10px; }
  }
</style>
