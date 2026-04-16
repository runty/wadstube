<script>
  import VideoCard from "./VideoCard.svelte";
  import { videos, refreshing, searchQuery, activeChannelId } from "../stores/feed.js";

  const emptyImage = "/wads.png";

  $: byChannel = $activeChannelId
    ? $videos.filter((v) => v.channel_id === $activeChannelId)
    : $videos;

  $: filtered = $searchQuery
    ? byChannel.filter((v) => {
        const q = $searchQuery.toLowerCase();
        return v.title?.toLowerCase().includes(q) ||
          v.channel?.toLowerCase().includes(q) ||
          v.description?.toLowerCase().includes(q);
      })
    : byChannel;
</script>

<div class="grid-wrapper">
  {#if $refreshing}
    <div class="loading">Refreshing...</div>
  {/if}

  {#if filtered.length === 0 && !$refreshing}
    <div class="empty">
      {#if $videos.length === 0}
        <img src={emptyImage} alt="" class="empty-img" />
        <p>Select a folder to view videos.</p>
      {:else}
        <p>No videos match your search.</p>
      {/if}
    </div>
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
  .empty-img {
    display: block;
    max-width: 280px;
    width: 60%;
    height: auto;
    margin: 0 auto 16px;
    opacity: 0.85;
  }
</style>
