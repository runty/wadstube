<script>
  import { activeFolder, refreshFolder, refreshing, error, sidebarOpen, searchQuery, folders, toast } from "../stores/feed.js";
  import { setThemeMode, themeMode } from "../stores/theme.js";

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
  <button class="menu-btn" type="button" on:click={toggleSidebar} title="Toggle folders">
    &#9776;
  </button>
  <div class="brand-wrapper">
    <button
      class="brand-button"
      on:click|stopPropagation={() => showGearMenu = !showGearMenu}
      aria-haspopup="menu"
      aria-expanded={showGearMenu}
      title="Settings"
    >
      <span class="brand-mark" aria-hidden="true">
        <img src="/wads.png" alt="" />
      </span>
      <span class="brand-title">WadsTube</span>
    </button>
    {#if showGearMenu}
      <div class="gear-menu title-menu" role="menu" aria-label="Settings">
        <button type="button" on:click={handleBackup} role="menuitem">&#8615; Backup</button>
        <button type="button" on:click={handleRestoreClick} role="menuitem">&#8613; Restore</button>
      </div>
    {/if}
  </div>
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
  <input type="file" accept=".json" bind:this={fileInput} on:change={handleRestoreFile} hidden />
  <div class="header-actions">
    <div class="wads-theme-switch" role="group" aria-label="Color theme">
      <button
        class:active={$themeMode === "system"}
        type="button"
        on:click={() => setThemeMode("system")}
        aria-label="Follow system theme"
        aria-pressed={$themeMode === "system"}
        title="Follow system theme"
      >
        <span aria-hidden="true">◐</span>
      </button>
      <button
        class:active={$themeMode === "light"}
        type="button"
        on:click={() => setThemeMode("light")}
        aria-label="Use light theme"
        aria-pressed={$themeMode === "light"}
        title="Use light theme"
      >
        <span aria-hidden="true">☼</span>
      </button>
      <button
        class:active={$themeMode === "dark"}
        type="button"
        on:click={() => setThemeMode("dark")}
        aria-label="Use dark theme"
        aria-pressed={$themeMode === "dark"}
        title="Use dark theme"
      >
        <span aria-hidden="true">☾</span>
      </button>
    </div>
    <button class="refresh-btn" type="button" on:click={handleRefresh} disabled={$refreshing}>
      {#if $refreshing}
        <span class="spinner" aria-hidden="true"></span>
        <span class="refresh-label">Refreshing...</span>
      {:else}
        <span class="refresh-icon" aria-hidden="true">&#8635;</span>
        <span class="refresh-label">Refresh</span>
      {/if}
    </button>
  </div>
</header>

{#if $error && String($error).trim()}
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
    background: color-mix(in srgb, var(--card-bg) 92%, transparent);
    backdrop-filter: blur(18px);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 44px;
    background: var(--button);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 1.32rem;
    line-height: 1;
    cursor: pointer;
    width: 44px;
    height: 44px;
    padding: 0;
    border-radius: 8px;
  }
  .menu-btn:hover {
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }
  .brand-wrapper {
    display: flex;
    align-items: center;
    position: relative;
    flex: 0 0 auto;
  }
  .brand-button {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    border: 0;
    background: transparent;
    color: var(--heading);
    padding: 0 4px;
    border-radius: 7px;
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  .brand-button:hover {
    background: var(--hover-bg);
  }
  .brand-mark {
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    overflow: hidden;
    border: 1px solid rgb(var(--accent-rgb) / 0.24);
    border-radius: 8px;
    background: var(--card-bg);
    box-shadow: var(--shadow);
  }
  .brand-mark img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .brand-title {
    font-size: 1.2rem;
    font-weight: 700;
    line-height: 1.1;
    color: var(--heading);
  }
  .search-wrapper {
    flex: 1 1 220px;
    max-width: 400px;
    position: relative;
  }
  .search {
    width: 100%;
    background: var(--field);
    border: 1px solid var(--border);
    color: var(--text);
    min-height: 42px;
    padding: 0 34px 0 12px;
    border-radius: 8px;
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
  .search-clear:hover { color: var(--heading); background: var(--button); }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    margin-left: auto;
  }
  .wads-theme-switch {
    display: inline-grid;
    grid-template-columns: repeat(3, 30px);
    gap: 3px;
    min-height: 38px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-soft);
  }
  .wads-theme-switch button {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--text-muted);
    background: transparent;
    font-size: 0.9rem;
    line-height: 1;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease,
      transform 140ms ease;
  }
  .wads-theme-switch button:hover {
    color: var(--heading);
    background: var(--button);
  }
  .wads-theme-switch button.active {
    color: var(--ink);
    background: var(--accent);
  }
  .gear-menu {
    position: absolute;
    top: 100%;
    left: 58px;
    margin-top: 6px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    min-width: 230px;
    box-shadow: var(--shadow);
    z-index: 300;
  }
  .gear-menu button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 9px 10px;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .gear-menu button:hover {
    background: var(--button);
  }
  @media (max-width: 640px) {
    header {
      padding: 10px 12px;
      gap: 8px;
      flex-wrap: wrap;
    }
    .menu-btn {
      flex-basis: 40px;
      width: 40px;
      height: 40px;
    }
    .brand-button {
      gap: 8px;
      padding-inline: 0;
    }
    .brand-mark {
      width: 40px;
      height: 40px;
    }
    .brand-title {
      font-size: 0.98rem;
    }
    .header-actions {
      order: 3;
      gap: 8px;
      margin-left: auto;
    }
    .gear-menu {
      position: fixed;
      top: calc(var(--header-height) + 8px);
      left: 12px;
      right: 12px;
      width: auto;
      min-width: 0;
      margin-top: 0;
    }
    .search-wrapper {
      order: 4;
      flex: 1 1 100%;
      max-width: none;
    }
  }
  .refresh-btn {
    background: var(--accent);
    color: var(--ink);
    border: 1px solid transparent;
    padding: 6px 16px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 750;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 38px;
    position: relative;
  }
  .refresh-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 28px rgb(var(--accent-rgb) / 0.2);
  }
  .refresh-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgb(25 19 5 / 0.26);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .error-bar {
    background: rgb(var(--danger-rgb) / 0.92);
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
  @media (max-width: 640px) {
    .refresh-btn {
      width: 40px;
      height: 40px;
      padding: 0;
      font-size: 0.8rem;
      justify-content: center;
    }
    .refresh-label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  }
</style>
