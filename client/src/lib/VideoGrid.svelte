<script>
  import { onDestroy } from "svelte";
  import VideoCard from "./VideoCard.svelte";
  import {
    videos,
    refreshing,
    searchQuery,
    activeChannelId,
    activeFolder,
    hasMoreVideos,
    loadingMore,
    loadVideos,
    loadMoreVideos,
    error,
  } from "../stores/feed.js";

  const emptyImage = "/wads.png";
  const DEBOUNCE_MS = 250;

  let debounceTimer;
  let prevFolder;
  let prevChannel;
  let prevQuery;
  let initialized = false;

  function runLoad() {
    // Always jump back to the top when the visible set changes — switching
    // folder/channel or typing in search shouldn't leave you scrolled deep
    // into the previous view's results.
    window.scrollTo({ top: 0, behavior: "instant" });
    loadVideos($activeFolder, {
      channelId: $activeChannelId || null,
      q: $searchQuery || null,
    }).catch((err) => {
      error.set(err?.message || "Failed to load videos");
    });
  }

  $: {
    // Re-run whenever any of the three filter stores change. Search
    // changes are debounced; folder/channel changes fire immediately.
    const folderChanged = initialized && $activeFolder !== prevFolder;
    const channelChanged = initialized && $activeChannelId !== prevChannel;
    const queryChanged = initialized && $searchQuery !== prevQuery;

    if (!initialized) {
      initialized = true;
    } else if (folderChanged || channelChanged || queryChanged) {
      clearTimeout(debounceTimer);
      const debounce = queryChanged && !folderChanged && !channelChanged;
      if (debounce) {
        debounceTimer = setTimeout(runLoad, DEBOUNCE_MS);
      } else {
        runLoad();
      }
    }

    prevFolder = $activeFolder;
    prevChannel = $activeChannelId;
    prevQuery = $searchQuery;
  }

  onDestroy(() => clearTimeout(debounceTimer));

  // Infinite scroll: observe a sentinel at the bottom of the grid.
  function observeSentinel(node) {
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && $hasMoreVideos && !$loadingMore) {
          loadMoreVideos().catch((err) => {
            error.set(err?.message || "Failed to load more videos");
          });
        }
      },
      { rootMargin: "600px 0px" },
    );
    obs.observe(node);
    return { destroy: () => obs.disconnect() };
  }
</script>

<div class="grid-wrapper">
  {#if $refreshing}
    <div class="loading">Refreshing...</div>
  {/if}

  {#if $videos.length === 0 && !$refreshing}
    <div class="empty">
      {#if !$activeFolder}
        <img src={emptyImage} alt="" class="empty-img" />
        <p>Select a folder to view videos.</p>
      {:else if $searchQuery}
        <p>No videos match your search.</p>
      {:else}
        <p>No videos yet — click Refresh to fetch.</p>
      {/if}
    </div>
  {:else}
    <div class="grid">
      {#each $videos as video (video.video_id)}
        <VideoCard {video} />
      {/each}
    </div>

    {#if $hasMoreVideos}
      <div class="sentinel" use:observeSentinel>
        {#if $loadingMore}
          Loading more…
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .grid-wrapper {
    padding: 16px 24px 24px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }
  @media (max-width: 640px) {
    .grid {
      grid-template-columns: 1fr;
    }
    .grid-wrapper {
      padding: 12px 12px 16px;
    }
  }
  .empty,
  .loading {
    color: var(--text-muted);
    padding: 40px 0;
    text-align: center;
  }
  .empty-img {
    display: block;
    max-width: 320px;
    width: 60%;
    height: auto;
    margin: 0 auto 16px;
    border-radius: 18px;
    box-shadow: var(--shadow);
  }
  .sentinel {
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 0.85rem;
    margin-top: 16px;
  }
</style>
