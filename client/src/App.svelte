<script>
  import { onMount } from "svelte";
  import Header from "./lib/Header.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import VideoGrid from "./lib/VideoGrid.svelte";
  import FolderChannels from "./lib/FolderChannels.svelte";
  import Toast from "./lib/Toast.svelte";
  import RefreshProgress from "./lib/RefreshProgress.svelte";
  import ChannelHealth from "./lib/ChannelHealth.svelte";
  import RefreshPreview from "./lib/RefreshPreview.svelte";
  import OperationsPanel from "./lib/OperationsPanel.svelte";
  import { loadFolders, sidebarOpen, showChannelsFor, showHealth, showOperations, showRefreshPreview, error, initializeUrlState, startUrlSync } from "./stores/feed.js";

  if (typeof window !== "undefined") initializeUrlState();

  onMount(() => {
    const stopUrlSync = startUrlSync();
    loadFolders().catch(() => error.set("Failed to load folders. Is the server running?"));

    if (window.innerWidth > 900) {
      sidebarOpen.set(true);
    }
    return stopUrlSync;
  });
</script>

<div class="app" class:sidebar-open={$sidebarOpen}>
  <Header />
  <Sidebar />
  <main>
    <VideoGrid />
  </main>
  {#if $showChannelsFor}
    <FolderChannels />
  {/if}
  {#if $showHealth}
    <ChannelHealth />
  {/if}
  {#if $showRefreshPreview}
    <RefreshPreview />
  {/if}
  {#if $showOperations}
    <OperationsPanel />
  {/if}
  <Toast />
  <RefreshProgress />
</div>

<style>
  .app {
    min-height: 100vh;
    background: var(--app-wash);
  }
  main {
    transition: margin-left 0.2s ease;
  }
  .sidebar-open main {
    margin-left: 280px;
  }
  @media (max-width: 900px) {
    .sidebar-open main {
      margin-left: 0;
    }
  }
</style>
