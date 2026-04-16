<script>
  import {
    folders,
    activeFolder,
    sidebarOpen,
    loadVideos,
    createFolderApi,
    renameFolderApi,
    deleteFolderApi,
    addChannelToFolder,
    showChannelsFor,
    error,
    toast,
  } from "../stores/feed.js";

  let expandedFolders = {};
  let contextMenu = null; // { x, y, folderName }
  let dragOverFolder = null;
  let showNewFolderInput = false;
  let newFolderName = "";
  let renamingFolder = null;
  let renameValue = "";

  function selectFolder(name) {
    activeFolder.set(name);
    loadVideos(name);
    if (window.innerWidth <= 900) {
      sidebarOpen.set(false);
    }
  }

  function toggleExpand(name) {
    expandedFolders[name] = !expandedFolders[name];
  }

  // Context menu (right-click on desktop, long-press on mobile)
  let longPressTimer;

  function handleContextMenu(e, folderName) {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, folderName);
  }

  function openContextMenu(x, y, folderName) {
    const menuW = 160, menuH = 120;
    x = Math.min(x, window.innerWidth - menuW);
    y = Math.min(y, window.innerHeight - menuH);
    contextMenu = { x, y, folderName };
  }

  function handleTouchStart(e, folderName) {
    const touch = e.touches[0];
    const x = touch.clientX;
    const y = touch.clientY;
    longPressTimer = setTimeout(() => {
      e.preventDefault();
      openContextMenu(x, y, folderName);
    }, 500);
  }

  function handleTouchEnd() {
    clearTimeout(longPressTimer);
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  function startRename(folderName) {
    renamingFolder = folderName;
    renameValue = folderName;
    closeContextMenu();
  }

  async function confirmRename() {
    if (renameValue.trim() && renameValue.trim() !== renamingFolder) {
      try {
        await renameFolderApi(renamingFolder, renameValue.trim());
      } catch (err) {
        error.set(err.message);
      }
    }
    renamingFolder = null;
    renameValue = "";
  }

  function handleRenameKeydown(e) {
    if (e.key === "Enter") confirmRename();
    if (e.key === "Escape") { renamingFolder = null; renameValue = ""; }
  }

  async function handleDelete(folderName) {
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
    } catch (err) {
      error.set(err.message);
    }
  }
</script>

<svelte:window on:click={closeContextMenu} />

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
          bind:value={renameValue}
          on:keydown={handleRenameKeydown}
          on:blur={confirmRename}
          autofocus
        />
      </div>
    {:else}
      <button
        class="folder-item"
        class:active={$activeFolder === folder.name}
        class:parent={folder.children?.length > 0}
        class:drag-over={dragOverFolder === folder.name}
        on:click={() => {
          selectFolder(folder.name);
          if (folder.children?.length > 0) toggleExpand(folder.name);
        }}
        on:contextmenu={(e) => handleContextMenu(e, folder.name)}
        on:touchstart={(e) => handleTouchStart(e, folder.name)}
        on:touchend={handleTouchEnd}
        on:touchmove={handleTouchEnd}
        on:dragover={(e) => handleDragOver(e, folder.name)}
        on:dragleave={handleDragLeave}
        on:drop={(e) => handleDrop(e, folder.name)}
      >
        {folder.name}
        <span class="count">{folder.channelCount}</span>
        {#if folder.children?.length > 0}
          <span class="arrow" class:rotated={expandedFolders[folder.name]}>&#9654;</span>
        {/if}
      </button>
    {/if}

    {#if folder.children?.length > 0 && expandedFolders[folder.name]}
      <div class="sub-list">
        {#each folder.children as child}
          {#if renamingFolder === child.name}
            <div class="rename-input sub">
              <input
                type="text"
                bind:value={renameValue}
                on:keydown={handleRenameKeydown}
                on:blur={confirmRename}
                autofocus
              />
            </div>
          {:else}
            <button
              class="folder-item sub"
              class:active={$activeFolder === child.name}
              class:drag-over={dragOverFolder === child.name}
              on:click={() => selectFolder(child.name)}
              on:contextmenu={(e) => handleContextMenu(e, child.name)}
              on:touchstart={(e) => handleTouchStart(e, child.name)}
              on:touchend={handleTouchEnd}
              on:touchmove={handleTouchEnd}
              on:dragover={(e) => handleDragOver(e, child.name)}
              on:dragleave={handleDragLeave}
              on:drop={(e) => handleDrop(e, child.name)}
            >
              {child.name}
              <span class="count">{child.channelCount}</span>
            </button>
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
  <div class="context-menu" style="left:{contextMenu.x}px;top:{contextMenu.y}px">
    <button on:click={() => handleViewChannels(contextMenu.folderName)}>View Channels</button>
    <button on:click={() => startRename(contextMenu.folderName)}>Rename</button>
    <button class="danger" on:click={() => handleDelete(contextMenu.folderName)}>Delete</button>
  </div>
{/if}

<style>
  aside {
    position: fixed;
    top: 49px;
    left: 0;
    bottom: 0;
    width: 260px;
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
    background: rgba(0,0,0,0.5);
    z-index: 140;
    border: none;
    cursor: default;
  }
  @media (max-width: 900px) {
    .overlay { display: block; }
  }
  .folder-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 10px 20px;
    font-size: 1rem;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: background 0.15s;
  }
  .folder-item:hover { background: var(--card-bg); }
  .folder-item.active {
    border-left-color: var(--accent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .folder-item.parent { font-weight: 600; }
  .folder-item.sub { padding-left: 36px; font-size: 0.9rem; }
  .folder-item.drag-over {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-left-color: var(--accent);
  }
  .count {
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-left: 6px;
  }
  .folder-item.active .count { color: var(--accent); opacity: 0.7; }
  .arrow {
    float: right;
    font-size: 0.7rem;
    color: var(--text-muted);
    transition: transform 0.2s;
  }
  .arrow.rotated { transform: rotate(90deg); }

  /* Context menu */
  .context-menu {
    position: fixed;
    z-index: 300;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 0;
    min-width: 140px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  .context-menu button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 8px 16px;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .context-menu button:hover { background: var(--bg); }
  .context-menu button.danger { color: var(--accent); }

  /* Rename input */
  .rename-input {
    padding: 4px 16px;
  }
  .rename-input.sub { padding-left: 32px; }
  .rename-input input {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--accent);
    color: var(--text);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.85rem;
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
