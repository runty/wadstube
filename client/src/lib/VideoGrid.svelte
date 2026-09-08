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
    loadReturnCount,
    listReturnsForScope,
    acknowledgeAllReturns,
    snapshotCurrentScope,
    returnCount,
    toast,
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
    loadReturnCount().catch((err) => { returnCount.set(0); error.set(err.message); });
  }

  let acknowledgingAll = false;
  let acknowledgementProgress = "";
  async function acknowledgeAll() {
    acknowledgingAll = true;
    acknowledgementProgress = "Loading…";
    try {
      const scope = snapshotCurrentScope();
      const exact = await listReturnsForScope(scope, 5000);
      if (!exact.videoIds?.length) { returnCount.set(0); return; }
      if (!confirm(
        `Acknowledge highlighted returns in this selected scope in batches? ${exact.count} ` +
        `currently listed. Returns arriving while this runs may also be included.`,
      )) return;
      const result = await acknowledgeAllReturns(scope, {
        initial: exact,
        onProgress: ({ acknowledged, batches }) => {
          acknowledgementProgress = `· ${acknowledged} changed · ${batches} batch${batches === 1 ? "" : "es"}`;
        },
      });
      const reloadWarning = result.reloadFailures ? ` · ${result.reloadFailures} view reload${result.reloadFailures === 1 ? "" : "s"} failed` : "";
      const message = result.complete
        ? `Return drain finished · ${result.acknowledged} changed across ${result.batches} batch${result.batches === 1 ? "" : "es"} · none remained at the final check${reloadWarning}`
        : `Return drain stopped · ${result.acknowledged} changed across ${result.batches} batch${result.batches === 1 ? "" : "es"} · ${result.remaining ?? "an unknown number"} remained at the last check${result.error ? ` · ${result.error}` : ""}${reloadWarning}`;
      toast.set({ message, type: result.complete && !result.reloadFailures ? "success" : "warning", durationMs: 10000 });
    } catch (err) { error.set(err.message); }
    finally { acknowledgingAll = false; acknowledgementProgress = ""; }
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
  <section class="feed-toolbar" aria-label="Feed display options">
      <select class="view-select" aria-label="Show videos" bind:value={$viewFilter}>
        <option value="all">All visible</option>
        <option value="unread">Unread</option>
        <option value="starred">Starred videos</option>
        <option value="hidden">Hidden</option>
        <option value="returns">Returns ({$returnCount})</option>
      </select>
    <label class="favorite-filter" class:active={$favoritesOnly} title="Only show videos from favorite channels">
      <input type="checkbox" bind:checked={$favoritesOnly} />
      <span>Favorite channels</span>
    </label>
      <select class="sort-select" aria-label="Sort videos" bind:value={$sortOrder}>
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="favorite">Favorites first</option>
        <option value="returning">Returns first</option>
      </select>
    <div class="density" role="group" aria-label="Video layout">
      {#each [["grid", "Grid", "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z"], ["compact", "Compact grid", "M3 3h4v4H3z M10 3h4v4h-4z M17 3h4v4h-4z M3 10h4v4H3z M10 10h4v4h-4z M17 10h4v4h-4z M3 17h4v4H3z M10 17h4v4h-4z M17 17h4v4h-4z"], ["list", "List", "M3 4h5v5H3z M12 5h9 M12 8h6 M3 15h5v5H3z M12 16h9 M12 19h6"]] as option}
        <button type="button" class:active={$density === option[0]} aria-pressed={$density === option[0]}
          aria-label={option[1]} title={option[1]} on:click={() => density.set(option[0])}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d={option[2]} /></svg>
        </button>
      {/each}
    </div>
    {#if $viewFilter === "returns" && $returnCount > 0}
      <button class="ack-all" type="button" on:click={acknowledgeAll} disabled={acknowledgingAll}>
        {acknowledgingAll ? `Draining returns ${acknowledgementProgress}` : `Acknowledge returns (${$returnCount} now)`}
      </button>
    {/if}
  </section>
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
  .feed-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); font-size: .85rem; }
  .feed-toolbar select, .favorite-filter, .ack-all { min-height: 40px; color: var(--text); background: var(--button); border: 1px solid var(--border); border-radius: 9px; padding: 7px 10px; }
  .feed-toolbar select { cursor: pointer; max-width: 100%; }
  .favorite-filter { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
  .favorite-filter input { margin: 0; width: 16px; height: 16px; accent-color: var(--accent-text); flex-shrink: 0; }
  .favorite-filter.active { border-color: var(--accent-text); color: var(--accent-text); }
  .sort-select { margin-left: auto; }
  .density { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--bg-soft); border: 1px solid var(--border); }
  .density button { display: grid; place-items: center; min-width: 34px; min-height: 32px; padding: 0; border: 1px solid transparent; border-radius: 6px; color: var(--text-muted); background: transparent; cursor: pointer; }
  .density button:hover { color: var(--text); background: var(--button); }
  .density button.active { color: var(--accent-text); background: var(--button); border-color: var(--accent-text); }
  .ack-all { flex-basis: 100%; color: var(--accent-text); cursor: pointer; text-align: left; }
  .ack-all:disabled { opacity: .65; cursor: wait; }
  @media (max-width: 640px), (pointer: coarse) {
    .feed-toolbar select, .favorite-filter, .ack-all { min-height: 44px; }
    .feed-toolbar select { font-size: 16px; }
    .density button { min-width: 44px; min-height: 44px; }
  }
  @media (max-width: 640px) {
    .feed-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
    .feed-toolbar select { width: 100%; min-width: 0; padding-left: 8px; padding-right: 2px; }
    .favorite-filter { min-width: 0; padding: 7px 8px; font-size: .8rem; line-height: 1.2; }
    .sort-select { margin-left: 0; }
    .density { justify-content: space-between; padding: 0; }
    .density button { flex: 1; min-width: 0; }
    .ack-all { grid-column: 1 / -1; }
  }
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
