<script>
  import { onMount } from "svelte";
  import { showChannelsFor, loadChannels, removeChannelFromFolder, addChannelToFolder, error, toast } from "../stores/feed.js";

  let channels = [];
  let loading = true;
  let addUrl = "";
  let adding = false;
  let dragOver = false;

  onMount(async () => {
    if ($showChannelsFor) {
      try {
        channels = await loadChannels($showChannelsFor);
      } catch (err) {
        error.set(err.message);
      }
      loading = false;
    }
  });

  function close() {
    showChannelsFor.set(null);
  }

  async function handleRemove(channelId) {
    if (!confirm("Remove this channel from the folder?")) return;
    try {
      await removeChannelFromFolder($showChannelsFor, channelId);
      channels = channels.filter((c) => c.id !== channelId);
    } catch (err) {
      error.set(err.message);
    }
  }

  async function handleAdd(url) {
    if (!url?.trim()) return;
    adding = true;
    try {
      const result = await addChannelToFolder($showChannelsFor, url.trim());
      channels = await loadChannels($showChannelsFor);
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

<div class="backdrop" on:click={close} on:keydown={() => {}} role="button" tabindex="-1"></div>
<div
  class="panel"
  class:drag-over={dragOver}
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
  on:drop={handleDrop}
>
  <div class="panel-header">
    <h2>{$showChannelsFor}</h2>
    <span class="channel-count">{channels.length} channels</span>
    <button class="close-btn" on:click={close}>&times;</button>
  </div>

  <div class="add-bar">
    <input
      type="text"
      placeholder="Paste YouTube URL to add channel..."
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
    {#if loading}
      <p class="status-msg">Loading channels...</p>
    {:else if channels.length === 0}
      <p class="status-msg">No channels in this folder.</p>
    {:else}
      {#each channels as ch}
        <div class="channel-row">
          <a
            href="https://www.youtube.com/channel/{ch.id}"
            target="_blank"
            rel="noopener"
            class="channel-link"
          >
            {ch.name}
          </a>
          <span class="channel-id">{ch.id}</span>
          <button class="remove-btn" on:click={() => handleRemove(ch.id)} title="Remove">
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
    background: rgba(0,0,0,0.5);
    z-index: 250;
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
    border-radius: 10px;
    z-index: 260;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    overflow-x: hidden;
  }
  .panel.drag-over {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
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
    color: var(--text);
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
    font-size: 1.4rem;
    cursor: pointer;
  }
  .close-btn:hover { color: var(--text); }

  .add-bar {
    display: flex;
    gap: 8px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }
  .add-bar input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.85rem;
    font-family: inherit;
    outline: none;
  }
  .add-bar input::placeholder { color: var(--text-muted); }
  .add-bar input:focus { border-color: var(--accent); }
  .add-btn {
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 0.82rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .add-btn:hover { opacity: 0.9; }
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
    background: var(--bg);
  }
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
  }
  .remove-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0 4px;
    flex-shrink: 0;
  }
  .remove-btn:hover { color: var(--accent); }
  .status-msg {
    color: var(--text-muted);
    font-style: italic;
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
    border-radius: 10px;
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
