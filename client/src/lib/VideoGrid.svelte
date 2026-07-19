<script>
  import { onDestroy } from "svelte";
  import VideoCard from "./VideoCard.svelte";
  import {
    videos,
    refreshing,
    searchQuery,
    activeChannelId,
    activeFolder,
    viewFilter,
    favoritesOnly,
    density,
    sortOrder,
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
  let prevView;
  let prevFavorites;
  let prevSort;
  let initialized = false;

  function runLoad() {
    // Always jump back to the top when the visible set changes — switching
    // folder/channel or typing in search shouldn't leave you scrolled deep
    // into the previous view's results.
    window.scrollTo({ top: 0, behavior: "instant" });
    loadVideos($activeFolder, {
      channelId: $activeChannelId || null,
      q: $searchQuery || null,
      view: $viewFilter,
      favorites: $favoritesOnly,
      sort: $sortOrder,
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
    const viewChanged = initialized && $viewFilter !== prevView;
    const favoritesChanged = initialized && $favoritesOnly !== prevFavorites;
    const sortChanged = initialized && $sortOrder !== prevSort;

    if (!initialized) {
      initialized = true;
      if ($activeFolder) queueMicrotask(runLoad);
    } else if (folderChanged || channelChanged || queryChanged || viewChanged || favoritesChanged || sortChanged) {
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
    prevView = $viewFilter;
    prevFavorites = $favoritesOnly;
    prevSort = $sortOrder;
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
  <div class="feed-toolbar" aria-label="Feed display options">
    <label>View
      <select bind:value={$viewFilter}>
        <option value="all">All visible</option>
        <option value="unread">Unread</option>
        <option value="starred">Starred videos</option>
        <option value="hidden">Hidden</option>
      </select>
    </label>
    <label class="check"><input type="checkbox" bind:checked={$favoritesOnly} /> Favorite channels</label>
    <label>Sort
      <select bind:value={$sortOrder}>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="favorite">Favorites first</option>
      </select>
    </label>
    <div class="density" role="group" aria-label="Card density">
      {#each [["grid", "Grid"], ["compact", "Compact"], ["list", "List"]] as option}
        <button class:active={$density === option[0]} aria-pressed={$density === option[0]}
          on:click={() => density.set(option[0])}>{option[1]}</button>
      {/each}
    </div>
  </div>
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
    <div class="grid" class:compact={$density === "compact"} class:list={$density === "list"}>
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
  .feed-toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; color: var(--text-muted); font-size: .8rem; }
  .feed-toolbar label { display: inline-flex; align-items: center; gap: 6px; }
  .feed-toolbar select, .density button { color: var(--text); background: var(--button); border: 1px solid var(--border); border-radius: 7px; padding: 6px 8px; }
  .density { display: inline-flex; margin-left: auto; }
  .density button { border-radius: 0; cursor: pointer; }
  .density button:first-child { border-radius: 7px 0 0 7px; }
  .density button:last-child { border-radius: 0 7px 7px 0; }
  .density button.active { color: var(--ink); background: var(--accent); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }
  .grid.compact { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .grid.list { grid-template-columns: 1fr; gap: 8px; }
  @media (max-width: 640px) {
    .grid {
      grid-template-columns: 1fr;
    }
    .grid-wrapper {
      padding: 12px 12px 16px;
    }
    .density { margin-left: 0; }
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
