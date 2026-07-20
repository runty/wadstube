<script>
  import { setVideoState, acknowledgeReturnVideos, toast, error } from "../stores/feed.js";
  export let video;

  async function update(changes, message) {
    try {
      await setVideoState(video.video_id, changes);
      toast.set({ message, type: "success" });
    } catch (err) { error.set(err.message); }
  }
  function markOpened() {
    if (!video.watched) update({ watched: true }, "Marked watched");
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(video.url);
      toast.set({ message: "Link copied", type: "success" });
    } catch { error.set("Could not copy the link"); }
  }
  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function highlightLabel(reason) {
    return {
      return_after_3_months: "Returned after 3 months",
      return_after_6_months: "Returned after 6 months",
      return_after_1_year: "Returned after 1 year",
    }[reason] || `Returned ${reason.replaceAll("_", " ")}`;
  }
  async function acknowledgeReturn() {
    try {
      const result = await acknowledgeReturnVideos([video.video_id]);
      const message = result.acknowledged ? "Return acknowledged" : "Return already acknowledged";
      toast.set({
        message: message + (result.reloadFailures ? ` · ${result.reloadFailures} view reload${result.reloadFailures === 1 ? "" : "s"} failed` : ""),
        type: result.reloadFailures ? "warning" : "success",
      });
    } catch (err) { error.set(err.message); }
  }
</script>

<article class="card" class:watched={video.watched} class:returning={!!video.highlight_reason}>
  <a class="thumb" href={video.url} target="_blank" rel="noopener" on:click={markOpened}
    aria-label={`Watch ${video.title} on YouTube`}>
    <img src={video.thumbnail} alt="" loading="lazy" />
    {#if video.highlight_reason}<span class="return-badge">{video.highlight_label || highlightLabel(video.highlight_reason)}</span>{/if}
  </a>
  <div class="card-body">
    <a class="card-title" href={video.url} target="_blank" rel="noopener" on:click={markOpened}>{video.title}</a>
    <div class="card-desc">{video.description?.slice(0, 150)}</div>
    <div class="channel-row">
      {#if video.channel_favorite}<span class="favorite" title="Favorite channel" aria-label="Favorite channel">★</span>{/if}
      <a class="card-channel" href={`https://www.youtube.com/channel/${video.channel_id}`} target="_blank" rel="noopener">{video.channel}</a>
    </div>
    <div class="card-meta"><time datetime={video.published}>{formatDate(video.published)}</time></div>
    <div class="actions" aria-label={`Actions for ${video.title}`}>
      <button on:click={() => update({ watched: !video.watched }, video.watched ? "Marked unread" : "Marked watched")}
        aria-pressed={video.watched}>{video.watched ? "Unread" : "Watched"}</button>
      <button class:active={video.starred} on:click={() => update({ starred: !video.starred }, video.starred ? "Removed star" : "Starred")}
        aria-pressed={video.starred}>{video.starred ? "★ Starred" : "☆ Star"}</button>
      <button on:click={() => update({ hidden: !video.hidden }, video.hidden ? "Restored video" : "Hidden")}>{video.hidden ? "Restore" : "Hide"}</button>
      <button on:click={copyLink}>Copy link</button>
      {#if video.highlight_reason}<button class="ack" on:click={acknowledgeReturn}>Acknowledge return</button>{/if}
    </div>
  </div>
</article>

<style>
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; box-shadow: var(--shadow); transition: transform .15s, border-color .15s; }
  .card:hover { transform: translateY(-2px); border-color: var(--border-strong); }
  .card.watched { opacity: .68; }
  .card.returning { border: 3px solid var(--danger); box-shadow: 0 0 0 2px rgb(var(--danger-rgb) / .28), var(--shadow); }
  .thumb { display: block; position: relative; }
  .thumb img { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; }
  .return-badge { position: absolute; left: 8px; bottom: 8px; max-width: calc(100% - 16px); background: var(--accent); color: var(--ink); border-radius: 5px; padding: 3px 7px; font-size: .72rem; font-weight: 800; }
  .card-body { padding: 10px 12px; }
  .card-title { font-family: var(--wads-display-font); font-size: 1rem; font-weight: 600; color: var(--heading); text-decoration: none; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px; }
  .card-title:hover, .card-channel:hover { color: var(--accent); text-decoration: underline; }
  .card-desc { font-family: var(--wads-display-font); font-size: .85rem; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 6px; line-height: 1.4; }
  .channel-row { display: flex; align-items: center; gap: 4px; }
  .favorite { color: var(--accent); }
  .card-channel { color: var(--accent); font-size: .88rem; font-weight: 700; text-decoration: none; font-family: var(--wads-display-font); }
  .card-meta { font-size: .78rem; color: var(--text-muted); }
  .actions { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
  .actions button { background: var(--button); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 7px; font-size: .72rem; cursor: pointer; }
  .actions button.active { color: var(--accent); border-color: var(--accent); }
  .actions button.ack { color: var(--accent); border-color: var(--accent); }
  :global(.grid.compact) .card-body { padding: 8px; }
  :global(.grid.compact) .card-desc { display: none; }
  :global(.grid.compact) .actions button { padding: 3px 5px; font-size: .66rem; }
  :global(.grid.list) .card { display: grid; grid-template-columns: minmax(180px, 260px) 1fr; }
  :global(.grid.list) .thumb img { height: 100%; }
  :global(.grid.list) .card-desc { -webkit-line-clamp: 1; }
  @media (max-width: 560px) { :global(.grid.list) .card { grid-template-columns: 130px 1fr; } .card-desc { display: none; } }
</style>
