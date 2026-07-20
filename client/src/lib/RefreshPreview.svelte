<script>
  import { onMount } from "svelte";
  import ModalShell from "./ModalShell.svelte";
  import { activeFolder, error, refreshFolder, refreshing, showRefreshPreview, toast } from "../stores/feed.js";
  import { formatReason, loadRefreshPreview } from "../stores/operations.js";
  import { rssFallbackSuffix } from "./refresh-report.js";
  let preview = null;
  let loading = true;
  let localError = "";
  const folderScope = $activeFolder;

  onMount(async () => {
    try { preview = await loadRefreshPreview(folderScope); }
    catch (err) { localError = err.message; }
    finally { loading = false; }
  });
  const close = () => showRefreshPreview.set(false);
  async function confirmRefresh() {
    localError = "";
    try {
      const result = await refreshFolder(folderScope);
      const failures = result.errors || 0;
      const reloadWarning = result.reloadFailures
        ? ` · ${result.reloadFailures} view reload${result.reloadFailures === 1 ? "" : "s"} failed`
        : "";
      toast.set({
        message: `${result.new_videos || 0} new videos · ${result.checked || 0} checked · ${result.skipped || 0} skipped · ${failures} errors · ${result.api_units || 0} API units · ${result.daily_remaining ?? "?"} left${rssFallbackSuffix(result)}${reloadWarning}`,
        type: failures || result.reloadFailures ? "warning" : result.new_videos ? "success" : "info", durationMs: 10_000,
      });
      close();
    } catch (err) { localError = err.message; error.set(err.message); }
  }
  function entries(value) { return Object.entries(value || {}); }
</script>

<ModalShell id="refresh-preview" title="Refresh preview" onClose={close}>
  <p slot="subtitle">This is an estimate. Confirming recomputes eligibility on the server.</p>
  {#if loading}<p role="status">Loading refresh plan…</p>
  {:else if localError}<p class="alert" role="alert">{localError}</p>
  {:else if preview}
    <div class="metrics">
      <div><strong>{preview.due_count}</strong><span>Due</span></div>
      <div><strong>{preview.skipped_count}</strong><span>Skipped</span></div>
      <div><strong>{preview.membership_count}</strong><span>Memberships</span></div>
      <div><strong>{preview.unresolved_count}</strong><span>Unresolved</span></div>
    </div>
    {#if preview.requested_mode !== preview.effective_mode}
      <p class="warning" role="status">Requested {preview.requested_mode.toUpperCase()}, but this run will use {preview.effective_mode.toUpperCase()} ({formatReason(preview.fallback_reason)}).</p>
    {/if}
    <section><h3>Plan</h3>
      <p>{preview.projected_required_api_units} API units required · {preview.quota?.buckets?.general?.remaining ?? "Unknown"} currently remaining.</p>
      <p>Mode: {preview.requested_mode} → {preview.effective_mode}. Reset: {preview.quota?.resetAt ? new Date(preview.quota.resetAt).toLocaleString() : "Unknown"}.</p>
      <p>Full library: {preview.full_pass?.channel_count || 0} channels, {preview.full_pass?.projected_api_units || 0} units, {preview.full_pass?.complete_passes_remaining ?? "?"} complete passes remaining.</p>
    </section>
    <div class="groups">
      <section><h3>Due reasons</h3>
        {#if !entries(preview.due_by_reason).length}<p>Nothing is due.</p>{/if}
        {#each entries(preview.due_by_reason) as [reason, count]}<p>{formatReason(reason)} <strong>{count}</strong></p>{/each}
      </section>
      <section><h3>Skipped reasons</h3>
        {#if !entries(preview.skipped_by_reason).length}<p>Nothing is skipped.</p>{/if}
        {#each entries(preview.skipped_by_reason) as [reason, count]}<p>{formatReason(reason)} <strong>{count}</strong></p>{/each}
      </section>
    </div>
  {/if}
  <svelte:fragment slot="footer">
    <button type="button" on:click={close}>Cancel</button>
    <button class="primary" type="button" on:click={confirmRefresh} disabled={loading || !!localError || $refreshing || !preview?.due_count}>
      {$refreshing ? "Refreshing…" : preview?.due_count ? `Refresh ${preview.due_count} due` : "Nothing due"}
    </button>
  </svelte:fragment>
</ModalShell>

<style>
  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .metrics div { padding: 12px; background: var(--button); border-radius: 8px; text-align: center; }
  .metrics strong, .metrics span { display: block; } .metrics strong { color: var(--heading); font-size: 1.3rem; } .metrics span, p { color: var(--text-muted); font-size: .82rem; }
  section { margin-top: 14px; } h3 { color: var(--heading); font-size: .9rem; margin-bottom: 5px; }
  .groups { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .groups p { display: flex; justify-content: space-between; margin: 4px 0; }
  .warning, .alert { padding: 10px; border-radius: 7px; background: rgb(var(--danger-rgb) / .12); color: var(--danger); }
  button { background: var(--button); color: var(--text); border: 1px solid var(--border); padding: 8px 12px; border-radius: 7px; }
  button.primary { background: var(--accent); color: var(--ink); border-color: var(--accent); }
  @media(max-width:560px){.metrics{grid-template-columns:1fr 1fr}.groups{grid-template-columns:1fr}}
</style>
