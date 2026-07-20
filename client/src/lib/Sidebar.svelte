<script>
  import FolderNode from "./FolderNode.svelte";
  import {
    folders, activeFolder, activeChannelId, sidebarOpen, createFolderApi,
    favoritesOnly, showHealth, error,
  } from "../stores/feed.js";

  let adding = false;
  let newFolderName = "";
  function selectAll() {
    favoritesOnly.set(false);
    activeFolder.set("__all__");
    activeChannelId.set(null);
    if (window.innerWidth <= 900) sidebarOpen.set(false);
  }
  async function addFolder() {
    if (!newFolderName.trim()) return;
    try {
      await createFolderApi(newFolderName.trim());
      newFolderName = ""; adding = false;
    } catch (err) { error.set(err.message); }
  }
</script>

{#if $sidebarOpen}<button class="overlay" on:click={() => sidebarOpen.set(false)} aria-label="Close sidebar"></button>{/if}
<aside class:open={$sidebarOpen} aria-label="Subscription folders">
  <button class="root" class:active={$activeFolder === "__all__" && !$favoritesOnly} on:click={selectAll}>All videos</button>
  <button class="root" class:active={$favoritesOnly} on:click={() => { activeFolder.set("__all__"); activeChannelId.set(null); favoritesOnly.set(!$favoritesOnly); }}>
    <span aria-hidden="true">★</span> Favorite channels
  </button>
  <button class="root" on:click={() => showHealth.set(true)}>Channel health</button>
  <div class="tree">
    {#each $folders as folder (folder.id)}
      <FolderNode {folder} depth={0} />
    {/each}
  </div>
  <div class="footer">
    {#if adding}
      <form on:submit|preventDefault={addFolder}>
        <label for="new-folder" class="sr-only">Folder name</label>
        <input id="new-folder" bind:value={newFolderName} placeholder="Folder name" />
        <button type="submit" aria-label="Create folder">+</button>
        <button type="button" on:click={() => adding = false} aria-label="Cancel">×</button>
      </form>
    {:else}<button on:click={() => adding = true}>+ New folder</button>{/if}
  </div>
</aside>

<style>
  aside { position: fixed; top: var(--header-height); left: 0; bottom: 0; width: 280px; background: color-mix(in srgb, var(--sidebar-bg) 96%, transparent); backdrop-filter: blur(18px); border-right: 1px solid var(--border); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; transform: translateX(-100%); transition: transform .2s; z-index: 150; padding: 10px 0; display: flex; flex-direction: column; }
  aside.open { transform: translateX(0); }
  .overlay { display: none; position: fixed; inset: 0; background: var(--overlay); z-index: 140; border: none; }
  .root { text-align: left; border: 0; background: transparent; color: var(--text); padding: 10px 16px; min-height: 42px; cursor: pointer; }
  .root:hover { background: var(--hover-bg); }
  .root.active { color: var(--accent); background: var(--active-bg); border-left: 3px solid var(--accent); }
  .tree { flex: 1; }
  .footer { border-top: 1px solid var(--border); padding: 10px; }
  .footer > button, form button { border: 1px solid var(--border); background: var(--button); color: var(--text); border-radius: 7px; padding: 7px 9px; cursor: pointer; }
  form { display: flex; gap: 4px; }
  form input { min-width: 0; flex: 1; background: var(--field); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 7px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  @media (max-width: 900px) { .overlay { display: block; } }
</style>
