<script>
  import { activeFolder, refreshFolder, refreshing, error, sidebarOpen, searchQuery, folders, toast } from "../stores/feed.js";

  let fileInput;
  let showGearMenu = false;

  function toggleSidebar() {
    sidebarOpen.update((v) => !v);
  }

  async function handleRefresh() {
    try {
      const result = await refreshFolder($activeFolder);
      const n = result?.new_videos ?? 0;
      const errs = result?.errors ?? 0;
      const msg = n === 0
        ? "No new videos"
        : `Added ${n} new video${n === 1 ? "" : "s"}`;
      const suffix = errs > 0 ? ` (${errs} channel${errs === 1 ? "" : "s"} errored)` : "";
      toast.set({ message: msg + suffix, type: n > 0 ? "success" : "info" });
    } catch {
      // error is already set in the store
    }
  }

  function closeGearMenu() { showGearMenu = false; }

  function dismissError() {
    error.set(null);
  }

  function handleBackup() {
    showGearMenu = false;
    window.open("/api/backup", "_blank");
  }

  function handleRestoreClick() {
    showGearMenu = false;
    fileInput.click();
  }

  async function handleRestoreFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!confirm(`Restore from "${file.name}"? This will replace all current folders and channels.`)) return;

      const resp = await fetch("/api/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error);

      folders.set(result.folders);
      toast.set({ message: "Backup restored successfully", type: "success" });
    } catch (err) {
      error.set(err.message || "Failed to restore backup");
    }

    // Reset file input so same file can be selected again
    e.target.value = "";
  }
</script>

<svelte:window on:click={closeGearMenu} />

<header>
  <button class="menu-btn" on:click={toggleSidebar} title="Toggle folders">
    &#9776;
  </button>
  <h1>WadsTube</h1>
  <div class="search-wrapper">
    <input
      class="search"
      type="text"
      placeholder="Search videos..."
      bind:value={$searchQuery}
    />
    {#if $searchQuery}
      <button class="search-clear" on:click={() => searchQuery.set("")}>&times;</button>
    {/if}
  </div>
  <div class="gear-wrapper">
    <button class="icon-btn" on:click|stopPropagation={() => showGearMenu = !showGearMenu} title="Settings">&#8942;</button>
    {#if showGearMenu}
      <div class="gear-menu">
        <button on:click={handleBackup}>&#8615; Backup</button>
        <button on:click={handleRestoreClick}>&#8613; Restore</button>
      </div>
    {/if}
  </div>
  <input type="file" accept=".json" bind:this={fileInput} on:change={handleRestoreFile} hidden />
  <button class="refresh-btn" on:click={handleRefresh} disabled={$refreshing}>
    {#if $refreshing}
      <span class="spinner"></span> Refreshing...
    {:else}
      &#8635; Refresh
    {/if}
  </button>
</header>

{#if $error}
  <div class="error-bar">
    <span>{$error}</span>
    <button class="dismiss" on:click={dismissError}>&times;</button>
  </div>
{/if}

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 200;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .menu-btn {
    background: none;
    border: none;
    color: var(--text);
    font-size: 1.4rem;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
  }
  .menu-btn:hover {
    background: var(--card-bg);
  }
  h1 {
    font-size: 1.2rem;
    color: var(--text);
  }
  .search-wrapper {
    flex: 1;
    max-width: 400px;
    position: relative;
  }
  .search {
    width: 100%;
    background: var(--card-bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 30px 6px 12px;
    border-radius: 6px;
    font-size: 0.85rem;
    outline: none;
    font-family: inherit;
  }
  .search::placeholder { color: var(--text-muted); }
  .search:focus { border-color: var(--accent); }
  .search-clear {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.4rem;
    cursor: pointer;
    padding: 4px 8px;
    line-height: 1;
  }
  .search-clear:hover { color: var(--text); }
  .icon-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
  }
  .icon-btn:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }
  .gear-wrapper {
    position: relative;
  }
  .gear-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 6px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 0;
    min-width: 140px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    z-index: 300;
  }
  .gear-menu button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 8px 16px;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .gear-menu button:hover {
    background: var(--bg);
  }
  @media (max-width: 640px) {
    header {
      padding: 10px 12px;
      gap: 8px;
    }
    h1 { display: none; }
    .search-wrapper { max-width: none; }
    .refresh-btn { padding: 6px 10px; font-size: 0.8rem; }
  }
  .refresh-btn {
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .refresh-btn:hover {
    opacity: 0.9;
  }
  .refresh-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .error-bar {
    background: #cc3333;
    color: #fff;
    padding: 10px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.85rem;
  }
  .dismiss {
    background: none;
    border: none;
    color: #fff;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 4px 10px;
    opacity: 0.8;
    line-height: 1;
  }
  .dismiss:hover {
    opacity: 1;
  }
</style>
