<script>
  import VideoCard from "./VideoCard.svelte";
  import { videos, refreshing, searchQuery } from "../stores/feed.js";

  $: filtered = $searchQuery
    ? $videos.filter((v) => {
        const q = $searchQuery.toLowerCase();
        return v.title?.toLowerCase().includes(q) ||
          v.channel?.toLowerCase().includes(q) ||
          v.description?.toLowerCase().includes(q);
      })
    : $videos;
</script>

<div class="grid-wrapper">
  {#if $refreshing}
    <div class="loading">Refreshing...</div>
  {/if}

  {#if filtered.length === 0 && !$refreshing}
    <div class="empty">{$videos.length === 0 ? 'Select a folder to view videos.' : 'No videos match your search.'}</div>
  {:else}
    <div class="grid">
      {#each filtered as video (video.video_id)}
        <VideoCard {video} />
      {/each}
    </div>
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
    font-style: italic;
    padding: 40px 0;
    text-align: center;
  }
</style>
