<script>
  import { onMount } from "svelte";
  import ModalShell from "./ModalShell.svelte";
  import { showChannelsFor, folders, channelLists, loadChannels, removeChannelFromFolder, addChannelToFolder, setChannelFavorite, resolveUnresolvedSubscription, error, toast } from "../stores/feed.js";
  import {
    isUnresolvedChannel, UNRESOLVED_CHANNEL_HELP, UNRESOLVED_CHANNEL_LABEL,
    ownValue,
  } from "./channel-display.js";

  let loading = true;
  let addUrl = "";
  let adding = false;
  let dragOver = false;
  let resolveInputs = {};
  let resolvingId = null;

  function findFolder(rows, id) {
    for (const row of rows) {
      if (row.id === id) return row;
      const found = findFolder(row.children || [], id);
      if (found) return found;
    }
    return null;
  }
  $: folderName = findFolder($folders, $showChannelsFor)?.name || "Folder";
  $: channels = ownValue($channelLists, $showChannelsFor, []);
  $: unresolvedCount = channels.filter(isUnresolvedChannel).length;

  onMount(() => {
    (async () => {
      if (!$showChannelsFor) return;
      try { await loadChannels($showChannelsFor, true); }
      catch (err) { error.set(err.message); }
      finally { loading = false; }
    })();
  });

  function close() {
    showChannelsFor.set(null);
  }

  async function favorite(channel) {
    try {
      await setChannelFavorite(channel.id, !channel.favorite);
    } catch (err) { error.set(err.message); }
  }

  async function handleRemove(channelId) {
    if (!confirm("Remove this channel from the folder?")) return;
    try {
      await removeChannelFromFolder($showChannelsFor, channelId);
    } catch (err) {
      error.set(err.message);
    }
  }

  async function handleAdd(url) {
    if (!url?.trim()) return;
    adding = true;
    try {
      const result = await addChannelToFolder($showChannelsFor, url.trim());
      await loadChannels($showChannelsFor, true);
      toast.set({ message: `Added "${result.channelName || "channel"}"`, type: "success" });
      addUrl = "";
    } catch (err) {
      error.set(err.message);
    } finally {
      adding = false;
    }
  }

  function handleAddKeydown(e) {
    if (e.key === "Enter") handleAdd(addUrl);
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  async function handleDrop(e) {
    e.preventDefault();
    dragOver = false;
    const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "";
    if (url.trim()) await handleAdd(url.trim());
  }
  function resolveValue(channel) { return ownValue(resolveInputs, channel.id, channel.id); }
  function setResolveValue(channel, value) { resolveInputs = { ...resolveInputs, [channel.id]: value }; }
  async function resolveChannel(channel) {
    const value = resolveValue(channel).trim();
    if (!value) return;
    resolvingId = channel.id;
    try {
      const result = await resolveUnresolvedSubscription($showChannelsFor, channel.id, value);
      toast.set({
        message: `Resolved ${result.channelName || channel.name}${result.reloadFailures ? ` · ${result.reloadFailures} view reload${result.reloadFailures === 1 ? "" : "s"} failed` : ""}`,
        type: result.reloadFailures ? "warning" : "success",
      });
      const next = { ...resolveInputs }; delete next[channel.id]; resolveInputs = next;
    } catch (err) { error.set(err.message); }
    finally { resolvingId = null; }
  }
</script>

<ModalShell id="folder-channels" title={folderName} onClose={close}>
  <p slot="subtitle">{channels.length} channels · manage favorites, unresolved subscriptions, and additions.</p>
<div class="manager" class:drag-over={dragOver} role="region" aria-label="Channel manager drop area"
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
  on:drop={handleDrop}
>

  <div class="add-bar">
    <input
      type="text"
      placeholder="Paste YouTube URL to add channel..."
      aria-label="YouTube channel URL or channel ID"
      bind:value={addUrl}
      on:keydown={handleAddKeydown}
      disabled={adding}
    />
    <button class="add-btn" on:click={() => handleAdd(addUrl)} disabled={adding || !addUrl.trim()}>
      {#if adding}
        Adding...
      {:else}
        + Add
      {/if}
    </button>
  </div>

  <div class="panel-body">
    {#if unresolvedCount}
      <p class="unresolved-help">
        {unresolvedCount} {unresolvedCount === 1 ? "subscription needs" : "subscriptions need"} resolution.
        {UNRESOLVED_CHANNEL_HELP}
      </p>
    {/if}
    {#if loading}
      <p class="status-msg">Loading channels...</p>
    {:else if channels.length === 0}
      <p class="status-msg">No channels in this folder.</p>
    {:else}
      {#each channels as ch, index}
        <div class="channel-row" class:unresolved={isUnresolvedChannel(ch)}>
          {#if isUnresolvedChannel(ch)}
            <div class="resolve-block">
              <span class="channel-link" title={UNRESOLVED_CHANNEL_HELP}>{ch.name} · {UNRESOLVED_CHANNEL_LABEL}</span>
              <div class="resolve-controls">
                <label class="sr-only" for={`resolve-${index}`}>Resolve {ch.name}</label>
                <input id={`resolve-${index}`} value={resolveValue(ch)} on:input={(event) => setResolveValue(ch, event.currentTarget.value)} disabled={!!resolvingId} />
                <button type="button" on:click={() => resolveChannel(ch)} disabled={!!resolvingId || !resolveValue(ch).trim()}>{resolvingId === ch.id ? "Resolving…" : "Resolve"}</button>
                <button type="button" on:click={() => setResolveValue(ch, ch.id)} disabled={!!resolvingId}>Cancel</button>
              </div>
            </div>
          {:else}
            <a
              href="https://www.youtube.com/channel/{ch.id}"
              target="_blank"
              rel="noopener"
              class="channel-link"
            >
              {ch.name}
            </a>
          {/if}
          <span class="channel-id">{ch.id}</span>
          {#if !isUnresolvedChannel(ch)}
            <button class="favorite-btn" class:active={ch.favorite} aria-pressed={ch.favorite} on:click={() => favorite(ch)} aria-label={`${ch.favorite ? "Remove" : "Add"} ${ch.name} as favorite`}>
              {ch.favorite ? "★" : "☆"}
            </button>
          {/if}
          <button class="remove-btn" on:click={() => handleRemove(ch.id)} title="Remove" aria-label={`Remove ${ch.name}`}>
            &times;
          </button>
        </div>
      {/each}
    {/if}
  </div>

  {#if dragOver}
    <div class="drop-overlay">Drop URL to add channel</div>
  {/if}
</div>
</ModalShell>

<style>
  .manager {
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .manager.drag-over {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgb(var(--accent-rgb) / 0.45), var(--shadow);
  }
  .add-bar {
    display: flex;
    gap: 8px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }
  .add-bar input {
    flex: 1;
    background: var(--field);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-family: inherit;
    outline: none;
  }
  .add-bar input::placeholder { color: var(--text-muted); }
  .add-bar input:focus { border-color: var(--accent); }
  .add-btn {
    background: var(--accent);
    color: var(--ink);
    border: none;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 0.82rem;
    font-weight: 750;
    cursor: pointer;
    white-space: nowrap;
  }
  .add-btn:hover { transform: translateY(-1px); }
  .add-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .panel-body {
    overflow-y: auto;
    padding: 8px 0;
  }
  .channel-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 20px;
  }
  .channel-row:hover {
    background: var(--hover-bg);
  }
  .channel-row.unresolved { border-left: 3px solid var(--danger); }
  .unresolved-help { margin: 6px 14px; padding: 9px 11px; color: var(--text-muted); background: var(--button); border-radius: 7px; font-size: .78rem; }
  .resolve-block { flex: 1; min-width: 0; }
  .resolve-controls { display: flex; gap: 5px; margin-top: 5px; }
  .resolve-controls input { flex: 1; min-width: 0; background: var(--field); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px; }
  .resolve-controls button { background: var(--button); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 7px; }
  .sr-only { position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0); }
  .channel-link {
    color: var(--text);
    text-decoration: none;
    font-size: 0.85rem;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .channel-link:hover {
    color: var(--accent);
  }
  .channel-id {
    color: var(--text-muted);
    font-size: 0.7rem;
    font-family: monospace;
    flex-shrink: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove-btn, .favorite-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.4rem;
    cursor: pointer;
    padding: 4px 8px;
    flex-shrink: 0;
    line-height: 1;
    border-radius: 4px;
  }
  .favorite-btn.active { color: var(--accent); }
  .remove-btn:hover { color: var(--danger); background: var(--button); }
  .status-msg {
    color: var(--text-muted);
    padding: 20px;
    text-align: center;
  }
  .drop-overlay {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    font-size: 1.1rem;
    font-weight: 600;
    pointer-events: none;
    border-radius: 8px;
  }
  @media (max-width: 640px) {
    .channel-id { display: none; }
    .add-bar { padding: 10px 14px; }
    .add-bar input { font-size: 0.8rem; }
    .channel-row { padding: 8px 14px; }
  }
</style>
