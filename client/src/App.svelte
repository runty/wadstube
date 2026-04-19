<script>
  import { onMount } from "svelte";
  import Header from "./lib/Header.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import VideoGrid from "./lib/VideoGrid.svelte";
  import FolderChannels from "./lib/FolderChannels.svelte";
  import Toast from "./lib/Toast.svelte";
  import RefreshProgress from "./lib/RefreshProgress.svelte";
  import { loadFolders, loadVideos, sidebarOpen, showChannelsFor, error } from "./stores/feed.js";

  onMount(async () => {
    try {
      await loadFolders();
    } catch (err) {
      error.set("Failed to load folders. Is the server running?");
    }

    if (window.innerWidth > 900) {
      sidebarOpen.set(true);
    }
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
  <Toast />
  <RefreshProgress />
</div>

<style>
  .app {
    min-height: 100vh;
  }
  main {
    transition: margin-left 0.2s ease;
  }
  .sidebar-open main {
    margin-left: 260px;
  }
  @media (max-width: 900px) {
    .sidebar-open main {
      margin-left: 0;
    }
  }
</style>
