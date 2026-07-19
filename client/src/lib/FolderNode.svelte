<script>
  import {
    activeFolder, activeChannelId, sidebarOpen, folders, channelLists, loadChannels,
    renameFolderApi, deleteFolderApi, renameChannelApi, removeChannelFromFolder,
    moveChannelApi, addChannelToFolder, setChannelFavorite, showChannelsFor, error, toast,
  } from "../stores/feed.js";
  import {
    canUseAsFeedFilter, isUnresolvedChannel,
    moveDestinationFor, ownValue, UNRESOLVED_CHANNEL_HELP, UNRESOLVED_CHANNEL_LABEL,
  } from "./channel-display.js";
  export let folder;
  export let depth = 0;

  let openFolders = false;
  let openChannels = false;
  let loading = false;
  let dragOver = false;
  let moveDestinations = new Map();
  $: channels = ownValue($channelLists, folder.id, []);
  $: allFolders = (() => {
    const rows = [];
    const walk = (items) => items.forEach((item) => { rows.push(item); walk(item.children || []); });
    walk($folders);
    return rows;
  })();

  function selectFolder() {
    activeFolder.set(folder.id); activeChannelId.set(null);
    if (window.innerWidth <= 900) sidebarOpen.set(false);
  }
  function selectChannel(channel) {
    if (!canUseAsFeedFilter(channel)) return;
    activeFolder.set(folder.id); activeChannelId.set(channel.id);
    if (window.innerWidth <= 900) sidebarOpen.set(false);
  }
  async function toggleChannels() {
    openChannels = !openChannels;
    if (openChannels && !Object.hasOwn($channelLists, folder.id)) {
      loading = true;
      try { await loadChannels(folder.id); } catch (err) { error.set(err.message); }
      finally { loading = false; }
    }
  }
  async function toggleFavorite(channel) {
    try {
      await setChannelFavorite(channel.id, !channel.favorite);
      toast.set({ message: `${!channel.favorite ? "Added" : "Removed"} favorite`, type: "success" });
    } catch (err) { error.set(err.message); }
  }
  async function renameFolder() {
    const name = prompt("Rename folder", folder.name)?.trim();
    if (!name || name === folder.name) return;
    try { await renameFolderApi(folder.id, name); } catch (err) { error.set(err.message); }
  }
  async function deleteFolder() {
    if (!confirm(`Delete folder “${folder.name}” and its nested folders?`)) return;
    try { await deleteFolderApi(folder.id); } catch (err) { error.set(err.message); }
  }
  async function renameChannel(channel) {
    const name = prompt("Rename channel", channel.name)?.trim();
    if (!name || name === channel.name) return;
    try { await renameChannelApi(folder.id, channel.id, name); }
    catch (err) { error.set(err.message); }
  }
  async function removeChannel(channel) {
    if (!confirm(`Remove “${channel.name}” from ${folder.name}?`)) return;
    try { await removeChannelFromFolder(folder.id, channel.id); }
    catch (err) { error.set(err.message); }
  }
  async function moveChannel(channel) {
    const destination = moveDestinationFor(moveDestinations, channel);
    if (!destination) return;
    try {
      await moveChannelApi(folder.id, channel.id, destination);
      toast.set({ message: `Moved “${channel.name}”`, type: "success" });
    } catch (err) { error.set(err.message); }
  }
  function setMoveDestination(channel, event) {
    moveDestinations = new Map(moveDestinations);
    moveDestinations.set(channel.id, event.currentTarget.value);
  }
  async function dropChannel(event) {
    event.preventDefault(); dragOver = false;
    const value = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (!value.trim()) return;
    try {
      const result = await addChannelToFolder(folder.id, value.trim());
      toast.set({ message: `Added “${result.channelName || "channel"}”`, type: "success" });
    } catch (err) { error.set(err.message); }
  }
  function escapeDetails(node) {
    const keydown = (event) => {
      if (event.key !== "Escape" || !node.open) return;
      event.preventDefault();
      node.open = false;
      node.querySelector("summary")?.focus();
    };
    node.addEventListener("keydown", keydown);
    return { destroy: () => node.removeEventListener("keydown", keydown) };
  }
</script>

<div class="node" style={`--depth:${depth}`}>
  <div class="folder-row" class:drag-over={dragOver} role="group" aria-label={folder.name}
    on:dragover={(event) => { event.preventDefault(); dragOver = true; }}
    on:dragleave={() => dragOver = false} on:drop={dropChannel}>
    <button class="toggle" on:click={toggleChannels} aria-expanded={openChannels} aria-label={`${openChannels ? "Collapse" : "Expand"} channels in ${folder.name}`}>▸</button>
    <button class="folder" class:active={$activeFolder === folder.id && !$activeChannelId} on:click={selectFolder}>
      <span>{folder.name}</span><small>{folder.unreadCount || 0}/{folder.channelCount}</small>
    </button>
    {#if folder.children?.length}<button class="toggle child" class:expanded={openFolders} on:click={() => openFolders = !openFolders} aria-expanded={openFolders} aria-label={`${openFolders ? "Collapse" : "Expand"} nested folders`}>▸</button>{/if}
    <details class="actions" use:escapeDetails>
      <summary class="more" aria-label={`Actions for ${folder.name}`}>•••</summary>
      <div class="menu">
        <button on:click={() => showChannelsFor.set(folder.id)}>Manage channels</button>
        <button on:click={renameFolder}>Rename folder</button>
        <button class="danger" on:click={deleteFolder}>Delete folder</button>
      </div>
    </details>
  </div>
  {#if openChannels}
    <div class="channels" aria-label={`Channels in ${folder.name}`}>
      {#if loading}<div class="status">Loading…</div>{/if}
      {#each channels as channel (channel.id)}
        <div class="channel-row">
          {#if isUnresolvedChannel(channel)}
            <div class="channel unresolved" title={UNRESOLVED_CHANNEL_HELP}>
              <span>{channel.name}</span><small class="needs-resolution">{UNRESOLVED_CHANNEL_LABEL}</small>
            </div>
          {:else}
            <button class="channel" class:active={$activeChannelId === channel.id} on:click={() => selectChannel(channel)} title={channel.name}>
              <span>{channel.name}</span>{#if channel.unreadCount}<small>{channel.unreadCount}</small>{/if}
            </button>
            <button class="star" class:active={channel.favorite} aria-pressed={channel.favorite} on:click={() => toggleFavorite(channel)} aria-label={`${channel.favorite ? "Remove" : "Add"} ${channel.name} as favorite`}>{channel.favorite ? "★" : "☆"}</button>
          {/if}
          <details class="actions" use:escapeDetails><summary aria-label={`Actions for ${channel.name}`}>⋮</summary><div class="menu channel-menu">
            <button on:click={() => renameChannel(channel)}>Rename</button>
            <label>Move to
              <select value={moveDestinationFor(moveDestinations, channel)} on:change={(event) => setMoveDestination(channel, event)}>
                <option value="">Choose folder…</option>
                {#each allFolders as destination (destination.id)}
                  {#if destination.id !== folder.id}<option value={destination.id}>{destination.name}</option>{/if}
                {/each}
              </select>
            </label>
            <button on:click={() => moveChannel(channel)} disabled={!moveDestinationFor(moveDestinations, channel)}>Move</button>
            <button on:click={() => removeChannel(channel)}>Remove</button>
          </div></details>
        </div>
      {/each}
    </div>
  {/if}
  {#if openFolders}
    {#each folder.children as child (child.id)}<svelte:self folder={child} depth={depth + 1} />{/each}
  {/if}
</div>

<style>
  .node { --indent: calc(var(--depth) * 14px); }
  .folder-row, .channel-row { display: flex; align-items: center; padding-left: var(--indent); }
  .folder-row.drag-over { background: var(--active-bg); box-shadow: inset 3px 0 var(--accent); }
  button { cursor: pointer; color: var(--text); }
  .toggle, .more, .star { flex: 0 0 30px; min-height: 38px; border: 0; background: transparent; }
  .toggle { transition: transform .15s; }
  .toggle[aria-expanded="true"] { transform: rotate(90deg); }
  .toggle.child { margin-left: -8px; }
  .folder, .channel { flex: 1; min-width: 0; display: flex; gap: 5px; align-items: center; text-align: left; border: 0; background: transparent; min-height: 40px; padding: 6px; }
  .folder span, .channel span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  small { margin-left: auto; color: var(--text-muted); }
  .folder:hover, .channel:hover, .more:hover, .star:hover { background: var(--hover-bg); }
  .folder.active, .channel.active { color: var(--accent); background: var(--active-bg); }
  .channels { padding-left: 22px; }
  .channel { color: var(--text-muted); font-size: .86rem; }
  .channel.unresolved { cursor: default; color: var(--text-muted); }
  .needs-resolution { color: var(--danger); font-size: .65rem; white-space: nowrap; }
  .star.active { color: var(--accent); }
  details.actions { position: relative; }
  summary { cursor: pointer; list-style: none; padding: 8px 10px; }
  .menu { position: absolute; right: 4px; top: 30px; z-index: 220; min-width: 150px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 7px; box-shadow: var(--shadow); padding: 4px; }
  .channel-menu { min-width: 210px; }
  .menu button { display: block; width: 100%; border: 0; background: transparent; text-align: left; padding: 7px; }
  .menu button:hover { background: var(--hover-bg); }
  .menu button.danger { color: var(--danger); }
  .menu label { display: block; padding: 7px; font-size: .78rem; color: var(--text-muted); }
  .menu select { display: block; width: 100%; margin-top: 3px; padding: 5px; background: var(--field); color: var(--text); border: 1px solid var(--border); border-radius: 5px; }
  .status { color: var(--text-muted); font-size: .8rem; padding: 5px 10px; }
</style>
