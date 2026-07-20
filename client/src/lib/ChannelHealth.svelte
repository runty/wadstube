<script>
  import { onMount } from "svelte";
  import ModalShell from "./ModalShell.svelte";
  import {
    channelHealth, showHealth, loadChannelHealth, error, toast, quotaStatus,
    refreshRuns, loadQuotaStatus, loadRefreshRuns, folders, loadFolders,
    quotaStatusStale, reloadAfterBulkAction,
  } from "../stores/feed.js";
  import {
    bulkDelete, bulkFavorite, bulkMove, bulkRefresh, MAX_BULK_CHANNELS,
    filterAndSortHealth, listFolderOptions, selectVisibleIds,
  } from "../stores/operations.js";

  let loading = true, busy = false, search = "", status = "all", due = "all", inactivity = "all", sort = "title";
  let selected = new Set(), sourceFolderId = "", destinationFolderId = "";
  $: visible = filterAndSortHealth($channelHealth, { search, status, due, inactivity, sort });
  $: folderOptions = listFolderOptions($folders);
  $: selectedRows = $channelHealth.filter((row) => selected.has(row.id));
  $: visibleSelectedCount = visible.filter((row) => selected.has(row.id)).length;
  $: hiddenSelectedCount = selected.size - visibleSelectedCount;
  $: movableIds = sourceFolderId ? selectedRows.filter((row) => row.folderIds?.includes(sourceFolderId)).map((row) => row.id) : [];
  $: folderNames = new Map(folderOptions.map((folder) => [folder.id, folder.name]));

  onMount(async () => {
    try { await Promise.all([loadChannelHealth("all"), loadQuotaStatus(), loadRefreshRuns(), loadFolders()]); }
    catch (err) { error.set(err.message); }
    finally { loading = false; }
  });
  const close = () => showHealth.set(false);
  function toggle(id) { const next = new Set(selected); next.has(id) ? next.delete(id) : next.add(id); selected = next; }
  function selectVisible() {
    selected = selectVisibleIds(selected, visible.map((row) => row.id));
  }
  async function act(ids, action, describe, { deleted = false } = {}) {
    const actionIds = [...ids];
    if (!actionIds.length || actionIds.length > MAX_BULK_CHANNELS) return;
    busy = true;
    let result = null, mutationError = null;
    try { result = await action(actionIds); }
    catch (err) { mutationError = err; }
    const reload = await reloadAfterBulkAction({
      deletedIds: deleted && !mutationError ? actionIds : [],
      mutationSucceeded: !mutationError,
    });
    if (mutationError) {
      error.set(mutationError.message);
    } else {
      selected = new Set([...selected].filter((id) => !actionIds.includes(id)));
      const report = describe(result);
      const reloadWarning = reload.reloadFailures ? ` · ${reload.reloadFailures} view reload${reload.reloadFailures === 1 ? "" : "s"} failed` : "";
      toast.set({ message: report.message + reloadWarning, type: reload.reloadFailures ? "warning" : report.type, durationMs: 10000 });
    }
    const valid = new Set($channelHealth.map((row) => row.id));
    selected = new Set([...selected].filter((id) => valid.has(id)));
    busy = false;
  }
  function refreshSelected() {
    const ids = [...selected];
    return act(ids, bulkRefresh, (result) => ({
      message: `${result.summary.checked || 0} checked · ${result.summary.errors || 0} errors · ${result.summary.api_units || 0} API units · ${result.summary.daily_remaining ?? "?"} left`,
      type: result.summary.errors ? "warning" : "success",
    }));
  }
  function favoriteSelected(favorite) {
    const ids = [...selected];
    return act(ids, (snapshot) => bulkFavorite(snapshot, favorite), () => ({ message: favorite ? "Channels favorited" : "Channels unfavorited", type: "success" }));
  }
  function deleteSelected() {
    const memberships = selectedRows.reduce((sum, row) => sum + (row.folderIds?.length || 0), 0);
    if (!confirm(`Delete ${selected.size} channels and ${memberships} folder memberships? Cached videos and refresh state will also be removed.`)) return;
    const ids = [...selected];
    return act(ids, bulkDelete, (result) => ({ message: `Deleted ${result.removedChannels} channels and ${result.removedMemberships} memberships`, type: "success" }), { deleted: true });
  }
  async function moveSelected() {
    if (!sourceFolderId || !destinationFolderId || !movableIds.length) return;
    if (!confirm(`Move ${movableIds.length} direct memberships from ${folderNames.get(sourceFolderId)} to ${folderNames.get(destinationFolderId)}?`)) return;
    const ids = [...movableIds];
    const source = sourceFolderId, destination = destinationFolderId;
    return act(ids, (snapshot) => bulkMove(snapshot, source, destination), (result) => ({ message: `${result.moved} moved · ${result.deduplicated} merged`, type: "success" }));
  }
  function age(value) {
    if (!value) return "Never"; const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
    return days < 1 ? "Today" : `${days}d ago`;
  }
  function until(value) {
    if (!value) return "unknown";
    const minutes = Math.ceil((new Date(value).getTime() - Date.now()) / 60000);
    if (minutes <= 0) return "now";
    if (minutes < 60) return `in ${minutes}m`;
    if (minutes < 1440) return `in ${Math.ceil(minutes / 60)}h`;
    return `in ${Math.ceil(minutes / 1440)}d`;
  }
</script>

<ModalShell id="channel-health" title="Channel health" onClose={close} wide>
  <p slot="subtitle">Search, filter, select, and run one bounded bulk operation.</p>
  <div class="filters">
    <label>Search<input type="search" bind:value={search} placeholder="Channel title or ID" disabled={busy} /></label>
    <label>Status<select bind:value={status} disabled={busy}><option value="all">All</option><option value="error">Errors</option><option value="ok">OK / unchanged</option></select></label>
    <label>Schedule<select bind:value={due} disabled={busy}><option value="all">All</option><option value="due">Due now</option><option value="later">Due later</option></select></label>
    <label>Upload inactivity<select bind:value={inactivity} disabled={busy}><option value="all">All</option><option value="none">No history</option><option value="lt90">Under 90 days</option><option value="90to364">90–364 days</option><option value="365plus">365+ days</option></select></label>
    <label>Sort<select bind:value={sort} disabled={busy}><option value="title">Title</option><option value="success">Last success</option><option value="upload">Last upload</option><option value="nextDue">Next due</option><option value="status">Status</option></select></label>
  </div>
  <div class="selection" aria-live="polite">
    <button type="button" on:click={selectVisible} disabled={busy}>{visible.length && visible.every((row) => selected.has(row.id)) ? "Clear visible" : "Select visible"}</button>
    <button type="button" on:click={() => selected = new Set()} disabled={busy || !selected.size}>Clear all</button>
    <strong>{selected.size} selected</strong><span>{visible.length} visible / {$channelHealth.length} total</span>
    {#if hiddenSelectedCount}<span>{hiddenSelectedCount} selected hidden by filters</span>{/if}
    <span>Maximum {MAX_BULK_CHANNELS} channels per bulk action.</span>
    <button type="button" on:click={refreshSelected} disabled={busy || !selected.size}>Refresh</button>
    <button type="button" on:click={() => favoriteSelected(true)} disabled={busy || !selected.size}>Favorite</button>
    <button type="button" on:click={() => favoriteSelected(false)} disabled={busy || !selected.size}>Unfavorite</button>
    <button class="danger" type="button" on:click={deleteSelected} disabled={busy || !selected.size}>Delete</button>
  </div>
  <div class="move-box">
    <label>Direct source folder<select bind:value={sourceFolderId} disabled={busy}><option value="">Choose source</option>{#each folderOptions as folder}<option value={folder.id}>{folder.label}</option>{/each}</select></label>
    <label>Destination folder<select bind:value={destinationFolderId} disabled={busy}><option value="">Choose destination</option>{#each folderOptions as folder}<option value={folder.id} disabled={folder.id === sourceFolderId}>{folder.label}</option>{/each}</select></label>
    <button type="button" on:click={moveSelected} disabled={busy || !sourceFolderId || !destinationFolderId || !movableIds.length}>Move {movableIds.length || ""}</button>
    <p>Only selected channels with a direct membership in the source move. Nested or other-folder memberships stay put.</p>
  </div>
  {#if $quotaStatusStale}<p class="quota danger-text">API quota status unavailable.</p>{:else if $quotaStatus?.buckets?.general}<p class="quota">API today: {$quotaStatus.buckets.general.used.toLocaleString()} / {$quotaStatus.buckets.general.limit.toLocaleString()} · {$quotaStatus.buckets.general.remaining.toLocaleString()} left · resets {new Date($quotaStatus.resetAt).toLocaleString()}</p>{/if}
  <div class="rows" aria-busy={loading || busy}>
    {#if loading}<p role="status">Loading channels…</p>{:else if !visible.length}<p>No channels match these filters.</p>{/if}
    {#each visible as channel (channel.id)}
      <article class:error-row={channel.last_refresh_status === "error"}>
        <input type="checkbox" checked={selected.has(channel.id)} on:change={() => toggle(channel.id)} aria-label={`Select ${channel.title}`} disabled={busy || (!selected.has(channel.id) && selected.size >= MAX_BULK_CHANNELS)} />
        <div><h3>{channel.favorite ? "★ " : ""}{channel.title}</h3>
          <p>{channel.folderIds?.map((id) => folderNames.get(id) || id).join(", ") || "No folder membership"}</p>
          <p>{channel.last_refresh_status || "Never refreshed"} · Success {age(channel.last_refreshed_at)} · Upload {age(channel.latest_upload_at)} · {channel.smart_refresh?.due ? "Due now" : `Next ${until(channel.smart_refresh?.nextDueAt)}`}</p>
          {#if channel.last_error}<p class="danger-text">{channel.last_error}</p>{/if}
        </div>
      </article>
    {/each}
  </div>
  <details><summary>Recent refresh reports ({$refreshRuns.length})</summary>{#each $refreshRuns.slice(0,10) as run}<p class:danger-text={run.errors > 0}>{new Date(run.started_at).toLocaleString()} · {run.trigger} · {run.checked} checked · {run.errors || 0} errors · {run.api_units} units · {run.daily_remaining ?? "?"} left</p>{/each}</details>
</ModalShell>

<style>
  .filters{display:grid;grid-template-columns:2fr repeat(4,1fr);gap:8px}.filters label,.move-box label{display:grid;gap:3px;color:var(--text-muted);font-size:.7rem}input,select,button{background:var(--button);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:7px 9px;min-width:0}
  .selection,.move-box{display:flex;align-items:end;gap:8px;flex-wrap:wrap;margin-top:12px;padding:10px;background:var(--button);border-radius:8px}.selection span,.quota,.move-box p{color:var(--text-muted);font-size:.75rem}.move-box p{flex-basis:100%;margin:0}.danger{color:var(--danger);border-color:var(--danger)}
  .rows{margin-top:10px;max-height:42vh;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}article{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:10px;border-bottom:1px solid var(--border)}article.error-row{border-left:3px solid var(--danger)}article h3{font-size:.86rem;color:var(--heading);margin:0}article p,details p{font-size:.72rem;color:var(--text-muted);margin:3px 0}.danger-text{color:var(--danger)!important}.quota{margin:10px 0}details{margin-top:12px;color:var(--heading)}
  @media(max-width:800px){.filters{grid-template-columns:1fr 1fr}.filters label:first-child{grid-column:1/-1}}
</style>
