<script>
  import {
    folders,
    activeFolder,
    activeChannelId,
    sidebarOpen,
    loadVideos,
    loadChannels,
    createFolderApi,
    renameFolderApi,
    deleteFolderApi,
    addChannelToFolder,
    removeChannelFromFolder,
    renameChannelApi,
    moveChannelApi,
    showChannelsFor,
    error,
    toast,
  } from "../stores/feed.js";

  let expandedFolders = {};       // subfolder expand state
  let expandedChannels = {};       // channel expand state
  let channelsCache = {};          // folderName -> channels[]
  let contextMenu = null;          // { x, y, type: 'folder'|'channel', folderName, channel? }
  let moveMenu = null;             // if user clicked "Move"
  let dragOverFolder = null;
  let showNewFolderInput = false;
  let newFolderName = "";
  let renamingFolder = null;
  let renameFolderValue = "";
  let renamingChannel = null;      // { folderName, channelId }
  let renameChannelValue = "";

  function selectFolder(name) {
    activeFolder.set(name);
    activeChannelId.set(null);
    loadVideos(name);
    if (window.innerWidth <= 900) {
      sidebarOpen.set(false);
    }
  }

  function selectChannel(folderName, channel) {
    activeChannelId.update((current) => current === channel.id ? null : channel.id);
    activeFolder.set(folderName);
    loadVideos(folderName);
    if (window.innerWidth <= 900) {
      sidebarOpen.set(false);
    }
  }

  function toggleSubfolders(name) {
    expandedFolders[name] = !expandedFolders[name];
  }

  async function toggleChannels(e, folderName) {
    e.stopPropagation();
    const open = !expandedChannels[folderName];
    expandedChannels[folderName] = open;
    if (open && !channelsCache[folderName]) {
      try {
        channelsCache[folderName] = await loadChannels(folderName);
        channelsCache = { ...channelsCache };
      } catch (err) {
        error.set(err.message);
      }
    }
  }

  async function refreshChannels(folderName) {
    try {
      channelsCache[folderName] = await loadChannels(folderName);
      channelsCache = { ...channelsCache };
    } catch (err) {
      error.set(err.message);
    }
  }

  // Context menu
  let longPressTimer;

  function handleFolderContextMenu(e, folderName) {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, { type: "folder", folderName });
  }

  function handleChannelContextMenu(e, folderName, channel) {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, { type: "channel", folderName, channel });
  }

  function openContextMenu(x, y, data) {
    const menuW = 180, menuH = 150;
    x = Math.min(x, window.innerWidth - menuW - 8);
    y = Math.min(y, window.innerHeight - menuH - 8);
    contextMenu = { x, y, ...data };
    moveMenu = null;
  }

  function handleFolderTouchStart(e, folderName) {
    const touch = e.touches[0];
    const x = touch.clientX, y = touch.clientY;
    longPressTimer = setTimeout(() => {
      e.preventDefault();
      openContextMenu(x, y, { type: "folder", folderName });
    }, 500);
  }

  function handleChannelTouchStart(e, folderName, channel) {
    const touch = e.touches[0];
    const x = touch.clientX, y = touch.clientY;
    longPressTimer = setTimeout(() => {
      e.preventDefault();
      openContextMenu(x, y, { type: "channel", folderName, channel });
    }, 500);
  }

  function handleTouchEnd() {
    clearTimeout(longPressTimer);
  }

  function closeContextMenu() {
    contextMenu = null;
    moveMenu = null;
  }

  // Folder rename/delete
  function startFolderRename(folderName) {
    renamingFolder = folderName;
    renameFolderValue = folderName;
    closeContextMenu();
  }

  async function confirmFolderRename() {
    if (renameFolderValue.trim() && renameFolderValue.trim() !== renamingFolder) {
      try {
        await renameFolderApi(renamingFolder, renameFolderValue.trim());
      } catch (err) {
        error.set(err.message);
      }
    }
    renamingFolder = null;
    renameFolderValue = "";
  }

  function handleFolderRenameKeydown(e) {
    if (e.key === "Enter") confirmFolderRename();
    if (e.key === "Escape") { renamingFolder = null; renameFolderValue = ""; }
  }

  async function handleFolderDelete(folderName) {
    closeContextMenu();
    if (confirm(`Delete folder "${folderName}"? This cannot be undone.`)) {
      try {
        await deleteFolderApi(folderName);
      } catch (err) {
        error.set(err.message);
      }
    }
  }

  function handleViewChannels(folderName) {
    closeContextMenu();
    showChannelsFor.set(folderName);
  }

  // Channel rename/delete/move
  function startChannelRename(folderName, channel) {
    renamingChannel = { folderName, channelId: channel.id };
    renameChannelValue = channel.name;
    closeContextMenu();
  }

  async function confirmChannelRename() {
    if (!renamingChannel) return;
    const { folderName, channelId } = renamingChannel;
    const newName = renameChannelValue.trim();
    if (newName && newName !== channelsCache[folderName]?.find(c => c.id === channelId)?.name) {
      try {
        await renameChannelApi(folderName, channelId, newName);
        await refreshChannels(folderName);
      } catch (err) {
        error.set(err.message);
      }
    }
    renamingChannel = null;
    renameChannelValue = "";
  }

  function handleChannelRenameKeydown(e) {
    if (e.key === "Enter") confirmChannelRename();
    if (e.key === "Escape") { renamingChannel = null; renameChannelValue = ""; }
  }

  async function handleChannelDelete(folderName, channel) {
    closeContextMenu();
    if (!confirm(`Remove "${channel.name}" from ${folderName}?`)) return;

    // Remember position so we can advance to the next channel after delete
    const wasActive = $activeChannelId === channel.id;
    const beforeList = channelsCache[folderName] || [];
    const deletedIdx = beforeList.findIndex((c) => c.id === channel.id);

    try {
      await removeChannelFromFolder(folderName, channel.id);
      await refreshChannels(folderName);

      if (wasActive) {
        const after = channelsCache[folderName] || [];
        if (after.length === 0) {
          activeChannelId.set(null);
        } else {
          // Pick channel at the same index, or the last one if we ran off the end
          const next = after[Math.min(deletedIdx, after.length - 1)];
          activeChannelId.set(next.id);
          loadVideos(folderName);
        }
      }
    } catch (err) {
      error.set(err.message);
    }
  }

  function handleKeydown(e) {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (!$activeChannelId || !$activeFolder) return;

    // Don't fire when user is typing
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    // Don't fire if a menu or rename is open
    if (contextMenu || moveMenu || renamingChannel || renamingFolder) return;

    // Find the channel object for the confirm dialog
    const channels = channelsCache[$activeFolder] || [];
    const channel = channels.find((c) => c.id === $activeChannelId)
      || { id: $activeChannelId, name: "this channel" };

    e.preventDefault();
    handleChannelDelete($activeFolder, channel);
  }

  function showMoveMenu() {
    if (!contextMenu || contextMenu.type !== "channel") return;
    moveMenu = { ...contextMenu };
    contextMenu = null;
  }

  async function handleMoveChannel(destFolder) {
    if (!moveMenu) return;
    const { folderName, channel } = moveMenu;
    const sourceFolder = folderName;
    moveMenu = null;
    try {
      await moveChannelApi(sourceFolder, channel.id, destFolder);
      // Refresh both folders' channel lists if cached
      if (channelsCache[sourceFolder]) await refreshChannels(sourceFolder);
      if (channelsCache[destFolder]) await refreshChannels(destFolder);
      toast.set({ message: `Moved "${channel.name}" to ${destFolder}`, type: "success" });
    } catch (err) {
      error.set(err.message);
    }
  }

  // Flatten all folder names (including subfolders), sorted alphabetically, for the Move menu
  $: allFolderNames = (() => {
    const names = [];
    for (const f of $folders) {
      names.push(f.name);
      for (const c of f.children || []) names.push(c.name);
    }
    return names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  })();

  // New folder
  async function handleNewFolder() {
    if (newFolderName.trim()) {
      try {
        await createFolderApi(newFolderName.trim());
        newFolderName = "";
        showNewFolderInput = false;
      } catch (err) {
        error.set(err.message);
      }
    }
  }

  function handleNewFolderKeydown(e) {
    if (e.key === "Enter") handleNewFolder();
    if (e.key === "Escape") { showNewFolderInput = false; newFolderName = ""; }
  }

  // Drag and drop
  function handleDragOver(e, folderName) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dragOverFolder = folderName;
  }

  function handleDragLeave() {
    dragOverFolder = null;
  }

  async function handleDrop(e, folderName) {
    e.preventDefault();
    dragOverFolder = null;

    const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "";
    if (!url.trim()) return;

    try {
      const result = await addChannelToFolder(folderName, url.trim());
      toast.set({ message: `Added "${result.channelName || "channel"}" to ${folderName}`, type: "success" });
      if (channelsCache[folderName]) await refreshChannels(folderName);
    } catch (err) {
      error.set(err.message);
    }
  }
</script>

<svelte:window on:click={closeContextMenu} on:keydown={handleKeydown} />

{#if $sidebarOpen}
  <button class="overlay" on:click={() => sidebarOpen.set(false)} aria-label="Close sidebar"></button>
{/if}

<aside class:open={$sidebarOpen}>
  <button
    class="folder-item"
    class:active={$activeFolder === "__all__"}
    on:click={() => selectFolder("__all__")}
  >
    All
  </button>

  {#each $folders as folder}
    {#if renamingFolder === folder.name}
      <div class="rename-input">
        <input
          type="text"
          bind:value={renameFolderValue}
          on:keydown={handleFolderRenameKeydown}
          on:blur={confirmFolderRename}
          autofocus
        />
      </div>
    {:else}
      <div class="folder-row" class:drag-over={dragOverFolder === folder.name}>
        <button
          class="chevron-btn"
          class:expanded={expandedChannels[folder.name]}
          on:click={(e) => toggleChannels(e, folder.name)}
          aria-label="Expand channels"
        ><span class="chevron-icon"></span></button>
        <button
          class="folder-item"
          class:active={$activeFolder === folder.name && !$activeChannelId}
          class:parent={folder.children?.length > 0}
          on:click={() => {
            selectFolder(folder.name);
            if (folder.children?.length > 0) toggleSubfolders(folder.name);
          }}
          on:contextmenu={(e) => handleFolderContextMenu(e, folder.name)}
          on:touchstart={(e) => handleFolderTouchStart(e, folder.name)}
          on:touchend={handleTouchEnd}
          on:touchmove={handleTouchEnd}
          on:dragover={(e) => handleDragOver(e, folder.name)}
          on:dragleave={handleDragLeave}
          on:drop={(e) => handleDrop(e, folder.name)}
        >
          <span class="folder-name">{folder.name}</span>
          <span class="count">{folder.channelCount}</span>
          {#if folder.children?.length > 0}
            <span class="subfolder-arrow" class:expanded={expandedFolders[folder.name]}>
              <span class="chevron-icon"></span>
            </span>
          {/if}
        </button>
      </div>
    {/if}

    {#if expandedChannels[folder.name]}
      <div class="channel-list">
        {#each (channelsCache[folder.name] || []) as channel (channel.id)}
          {#if renamingChannel?.channelId === channel.id && renamingChannel?.folderName === folder.name}
            <div class="rename-input channel-rename">
              <input
                type="text"
                bind:value={renameChannelValue}
                on:keydown={handleChannelRenameKeydown}
                on:blur={confirmChannelRename}
                autofocus
              />
            </div>
          {:else}
            <button
              class="channel-item"
              class:active={$activeChannelId === channel.id}
              on:click={() => selectChannel(folder.name, channel)}
              on:contextmenu={(e) => handleChannelContextMenu(e, folder.name, channel)}
              on:touchstart={(e) => handleChannelTouchStart(e, folder.name, channel)}
              on:touchend={handleTouchEnd}
              on:touchmove={handleTouchEnd}
              title={channel.name}
            >
              {channel.name}
            </button>
          {/if}
        {/each}
      </div>
    {/if}

    {#if folder.children?.length > 0 && expandedFolders[folder.name]}
      <div class="sub-list">
        {#each folder.children as child}
          {#if renamingFolder === child.name}
            <div class="rename-input sub">
              <input
                type="text"
                bind:value={renameFolderValue}
                on:keydown={handleFolderRenameKeydown}
                on:blur={confirmFolderRename}
                autofocus
              />
            </div>
          {:else}
            <div class="folder-row sub-row" class:drag-over={dragOverFolder === child.name}>
              <button
                class="chevron-btn sub"
                class:expanded={expandedChannels[child.name]}
                on:click={(e) => toggleChannels(e, child.name)}
                aria-label="Expand channels"
              ><span class="chevron-icon"></span></button>
              <button
                class="folder-item sub"
                class:active={$activeFolder === child.name && !$activeChannelId}
                on:click={() => selectFolder(child.name)}
                on:contextmenu={(e) => handleFolderContextMenu(e, child.name)}
                on:touchstart={(e) => handleFolderTouchStart(e, child.name)}
                on:touchend={handleTouchEnd}
                on:touchmove={handleTouchEnd}
                on:dragover={(e) => handleDragOver(e, child.name)}
                on:dragleave={handleDragLeave}
                on:drop={(e) => handleDrop(e, child.name)}
              >
                <span class="folder-name">{child.name}</span>
                <span class="count">{child.channelCount}</span>
              </button>
            </div>

            {#if expandedChannels[child.name]}
              <div class="channel-list sub">
                {#each (channelsCache[child.name] || []) as channel (channel.id)}
                  {#if renamingChannel?.channelId === channel.id && renamingChannel?.folderName === child.name}
                    <div class="rename-input channel-rename sub">
                      <input
                        type="text"
                        bind:value={renameChannelValue}
                        on:keydown={handleChannelRenameKeydown}
                        on:blur={confirmChannelRename}
                        autofocus
                      />
                    </div>
                  {:else}
                    <button
                      class="channel-item sub"
                      class:active={$activeChannelId === channel.id}
                      on:click={() => selectChannel(child.name, channel)}
                      on:contextmenu={(e) => handleChannelContextMenu(e, child.name, channel)}
                      on:touchstart={(e) => handleChannelTouchStart(e, child.name, channel)}
                      on:touchend={handleTouchEnd}
                      on:touchmove={handleTouchEnd}
                      title={channel.name}
                    >
                      {channel.name}
                    </button>
                  {/if}
                {/each}
              </div>
            {/if}
          {/if}
        {/each}
      </div>
    {/if}
  {/each}

  <div class="sidebar-footer">
    {#if showNewFolderInput}
      <div class="new-folder-input">
        <input
          type="text"
          placeholder="Folder name..."
          bind:value={newFolderName}
          on:keydown={handleNewFolderKeydown}
          autofocus
        />
        <button class="confirm-btn" on:click={handleNewFolder}>+</button>
      </div>
    {:else}
      <button class="new-folder-btn" on:click={() => (showNewFolderInput = true)}>
        + New Folder
      </button>
    {/if}
  </div>
</aside>

{#if contextMenu}
  <div class="context-menu" style="left:{contextMenu.x}px;top:{contextMenu.y}px" on:click|stopPropagation>
    {#if contextMenu.type === "folder"}
      <button on:click={() => handleViewChannels(contextMenu.folderName)}>View Channels</button>
      <button on:click={() => startFolderRename(contextMenu.folderName)}>Rename</button>
      <button class="danger" on:click={() => handleFolderDelete(contextMenu.folderName)}>Delete</button>
    {:else}
      <button on:click={() => startChannelRename(contextMenu.folderName, contextMenu.channel)}>Rename</button>
      <button on:click={showMoveMenu}>Move to folder...</button>
      <button class="danger" on:click={() => handleChannelDelete(contextMenu.folderName, contextMenu.channel)}>Delete</button>
    {/if}
  </div>
{/if}

{#if moveMenu}
  <div class="move-menu" on:click|stopPropagation>
    <div class="move-menu-header">Move "{moveMenu.channel.name}" to:</div>
    <div class="move-menu-list">
      {#each allFolderNames as name}
        {#if name !== moveMenu.folderName}
          <button on:click={() => handleMoveChannel(name)}>{name}</button>
        {/if}
      {/each}
    </div>
    <button class="move-cancel" on:click={() => moveMenu = null}>Cancel</button>
  </div>
{/if}

<style>
  aside {
    position: fixed;
    top: 49px;
    left: 0;
    bottom: 0;
    width: 280px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
    overflow-y: auto;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    z-index: 150;
    padding: 8px 0;
    display: flex;
    flex-direction: column;
  }
  aside.open { transform: translateX(0); }
  .overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: var(--overlay);
    z-index: 140;
    border: none;
    cursor: default;
  }
  @media (max-width: 900px) {
    .overlay { display: block; }
  }

  .folder-row {
    display: flex;
    align-items: stretch;
    border-left: 3px solid transparent;
    transition: background 0.15s;
  }
  .folder-row.drag-over {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-left-color: var(--accent);
  }

  .chevron-btn {
    background: none;
    border: none;
    padding: 0 4px 0 8px;
    cursor: pointer;
    min-width: 32px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .chevron-btn.sub { padding-left: 24px; }
  .chevron-icon {
    display: block;
    width: 0;
    height: 0;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-left: 7px solid var(--text-muted);
    transition: transform 0.15s ease;
  }
  @media (max-width: 900px) {
    .chevron-btn {
      min-width: 44px;
      padding: 0 10px 0 14px;
    }
    .chevron-btn.sub {
      padding-left: 30px;
    }
    .chevron-icon {
      border-top-width: 6px;
      border-bottom-width: 6px;
      border-left-width: 9px;
    }
  }
  .chevron-btn:hover .chevron-icon {
    border-left-color: var(--text);
  }
  .chevron-btn.expanded .chevron-icon {
    transform: rotate(90deg);
  }

  .folder-item {
    display: flex;
    align-items: center;
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 10px 16px 10px 0;
    font-size: 1rem;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    cursor: pointer;
    min-width: 0;
  }
  .folder-item:hover { background: var(--card-bg); }
  .folder-item.active {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .folder-row:has(.folder-item.active) { border-left-color: var(--accent); }
  .folder-item.parent { font-weight: 600; }
  .folder-item.sub { padding-left: 0; font-size: 0.9rem; }

  .folder-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .count {
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-left: 6px;
    flex-shrink: 0;
  }
  .folder-item.active .count { color: var(--accent); opacity: 0.7; }
  .subfolder-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-left: 6px;
    flex-shrink: 0;
    transition: transform 0.2s;
  }
  .subfolder-arrow.expanded { transform: rotate(90deg); }

  /* Channel list inside folder */
  .channel-list {
    padding: 2px 0;
  }
  .channel-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text-muted);
    padding: 6px 16px 6px 44px;
    font-size: 0.88rem;
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-left: 3px solid transparent;
  }
  .channel-item:hover {
    background: var(--card-bg);
    color: var(--text);
  }
  .channel-item.active {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border-left-color: var(--accent);
    font-weight: 600;
  }
  .channel-item.sub { padding-left: 60px; }
  .channel-list.sub .rename-input.channel-rename { padding-left: 56px; }
  .rename-input.channel-rename { padding-left: 40px; }

  /* Sub-folder row */
  .sub-list { }
  .sub-row { padding-left: 0; }

  /* Context menu */
  .context-menu {
    position: fixed;
    z-index: 300;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 0;
    min-width: 170px;
    box-shadow: var(--shadow);
  }
  .context-menu button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 10px 16px;
    font-size: 0.88rem;
    cursor: pointer;
  }
  .context-menu button:hover { background: var(--bg); }
  .context-menu button.danger { color: var(--accent); }

  /* Move submenu — centered overlay, responsive */
  .move-menu {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 300;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 0 0;
    width: 90%;
    max-width: 340px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow);
  }
  .move-menu-header {
    padding: 0 16px 12px;
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--text);
    border-bottom: 1px solid var(--border);
  }
  .move-menu-list {
    overflow-y: auto;
    padding: 4px 0;
    flex: 1;
  }
  .move-menu-list button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 10px 16px;
    font-size: 0.88rem;
    cursor: pointer;
  }
  .move-menu-list button:hover { background: var(--bg); }
  .move-cancel {
    background: var(--bg);
    border: none;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    padding: 10px;
    font-size: 0.88rem;
    cursor: pointer;
  }
  .move-cancel:hover { color: var(--text); }

  /* Rename input */
  .rename-input {
    padding: 4px 16px 4px 40px;
  }
  .rename-input.sub { padding-left: 56px; }
  .rename-input input {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--accent);
    color: var(--text);
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 0.9rem;
    outline: none;
  }

  /* New folder */
  .sidebar-footer {
    margin-top: auto;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .new-folder-btn {
    width: 100%;
    background: none;
    border: 1px dashed var(--border);
    color: var(--text-muted);
    padding: 6px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.82rem;
  }
  .new-folder-btn:hover { border-color: var(--accent); color: var(--accent); }
  .new-folder-input {
    display: flex;
    gap: 6px;
  }
  .new-folder-input input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.82rem;
    outline: none;
  }
  .new-folder-input input:focus { border-color: var(--accent); }
  .confirm-btn {
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
  }
</style>
