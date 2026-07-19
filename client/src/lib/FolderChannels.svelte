<script>
  import { onMount } from "svelte";
  import { showChannelsFor, folders, channelLists, loadChannels, removeChannelFromFolder, addChannelToFolder, setChannelFavorite, error, toast } from "../stores/feed.js";
  import {
    isUnresolvedChannel, UNRESOLVED_CHANNEL_HELP, UNRESOLVED_CHANNEL_LABEL,
    ownValue,
  } from "./channel-display.js";

  let loading = true;
  let addUrl = "";
  let adding = false;
  let dragOver = false;
  let panel;
  let closeButton;
  let previouslyFocused;

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
    previouslyFocused = document.activeElement;
    closeButton?.focus();
    (async () => {
      if (!$showChannelsFor) return;
      try { await loadChannels($showChannelsFor, true); }
      catch (err) { error.set(err.message); }
      finally { loading = false; }
    })();
    return () => previouslyFocused?.focus?.();
  });

  function close() {
    showChannelsFor.set(null);
  }

  function handleDialogKeydown(e) {
    if (e.key === "Escape") return close();
    if (e.key !== "Tab") return;
    const items = [...panel.querySelectorAll("button, input, a[href], [tabindex]:not([tabindex='-1'])")].filter((item) => !item.disabled);
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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
</script>

<button class="backdrop" on:click={close} aria-label="Close channel manager"></button>
<div
  class="panel"
  role="dialog"
  aria-modal="true"
  aria-labelledby="channels-title"
  tabindex="-1"
  bind:this={panel}
  on:keydown={handleDialogKeydown}
  class:drag-over={dragOver}
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
  on:drop={handleDrop}
>
  <div class="panel-header">
    <h2 id="channels-title">{folderName}</h2>
    <span class="channel-count">{channels.length} channels</span>
    <button class="close-btn" bind:this={closeButton} on:click={close} aria-label="Close channel manager">&times;</button>
  </div>

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
      {#each channels as ch}
        <div class="channel-row" class:unresolved={isUnresolvedChannel(ch)}>
          {#if isUnresolvedChannel(ch)}
            <span class="channel-link" title={UNRESOLVED_CHANNEL_HELP}>{ch.name}</span>
            <span class="unresolved-label">{UNRESOLVED_CHANNEL_LABEL}</span>
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

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    z-index: 250;
    border: 0;
  }
  .panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 90%;
    max-width: 560px;
    max-height: 80vh;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    z-index: 260;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    overflow-x: hidden;
    box-shadow: var(--shadow);
  }
  .panel.drag-over {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgb(var(--accent-rgb) / 0.45), var(--shadow);
  }
  .panel-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }
  .panel-header h2 {
    font-size: 1.1rem;
    color: var(--heading);
    margin: 0;
  }
  .channel-count {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .close-btn {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.6rem;
    cursor: pointer;
    padding: 4px 8px;
    line-height: 1;
    border-radius: 7px;
  }
  .close-btn:hover { color: var(--heading); background: var(--button); }

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
  .unresolved-label { color: var(--danger); font-size: .68rem; white-space: nowrap; }
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
    .panel {
      width: 95%;
      max-height: 85vh;
    }
    .channel-id { display: none; }
    .add-bar { padding: 10px 14px; }
    .add-bar input { font-size: 0.8rem; }
    .channel-row { padding: 8px 14px; }
    .panel-header { padding: 12px 14px; }
  }
</style>
