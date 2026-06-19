<script>
  import { refreshProgress } from "../stores/feed.js";
</script>

{#if $refreshProgress.active}
  <div class="progress">
    <div class="header">
      <span class="label">Refreshing</span>
      <span class="count">
        {$refreshProgress.done} / {$refreshProgress.total}
      </span>
      <span class="new">+{$refreshProgress.newCount} new</span>
      {#if $refreshProgress.errors > 0}
        <span class="err">{$refreshProgress.errors} errored</span>
      {/if}
    </div>
    <div class="lanes">
      {#each $refreshProgress.slots as slot (slot.channelId)}
        <div class="lane">
          <span class="spinner"></span>
          <span class="name">{slot.channelTitle || slot.channelId}</span>
        </div>
      {/each}
      {#if $refreshProgress.slots.length === 0}
        <div class="lane idle">waiting…</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .progress {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 280px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    box-shadow: var(--shadow);
    font-size: 0.8rem;
    z-index: 350;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: 6px;
    margin-bottom: 6px;
  }
  .label {
    color: var(--heading);
    font-weight: 600;
  }
  .count { margin-left: auto; }
  .new {
    color: var(--accent);
    font-weight: 600;
  }
  .err { color: var(--danger); }
  .lanes {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 18px;
  }
  .lane {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
  }
  .lane.idle {
    color: var(--text-muted);
    font-style: italic;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (max-width: 640px) {
    .progress {
      right: 10px;
      bottom: 10px;
      width: calc(100vw - 20px);
      max-width: 340px;
    }
  }
</style>
