<script>
  import { toast } from "../stores/feed.js";
  export let video;

  async function copyLink(e) {
    e.preventDefault();
    await navigator.clipboard.writeText(video.url);
    toast.set({ message: "Link copied", type: "success" });
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return (
      d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
  }

  function openVideo() {
    window.open(video.url, "_blank", "noopener");
  }

  function openChannel(e) {
    e.stopPropagation();
    window.open(`https://www.youtube.com/channel/${video.channel_id}`, "_blank", "noopener");
  }
</script>

<div class="card" on:click={openVideo} on:contextmenu={copyLink} on:keydown={(e) => { if (e.key === "Enter" || e.key === " ") openVideo(); }} role="link" tabindex="0">
  <img src={video.thumbnail} alt="" loading="lazy" />
  <div class="card-body">
    <div class="card-title">{video.title}</div>
    <div class="card-desc">{video.description?.slice(0, 150)}</div>
    <button class="card-channel" on:click={openChannel}>
      {video.channel}
    </button>
    <div class="card-meta">
      <span>{formatDate(video.published)}</span>
    </div>
  </div>
</div>

<style>
  .card {
    background: var(--card-bg);
    border-radius: 8px;
    overflow: hidden;
    transition: transform 0.15s;
    cursor: pointer;
  }
  .card:hover {
    transform: translateY(-2px);
  }
  .card img {
    width: 100%;
    aspect-ratio: 16/9;
    object-fit: cover;
    display: block;
  }
  .card-body {
    padding: 10px 12px;
  }
  .card-title {
    font-size: 1rem;
    font-weight: 600;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-bottom: 4px;
  }
  .card-desc {
    font-size: 0.85rem;
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .card-meta {
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .card-channel {
    display: inline;
    background: none;
    border: none;
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--accent);
    margin-bottom: 2px;
    cursor: pointer;
    padding: 0;
    font-family: inherit;
  }
  .card-channel:hover {
    color: var(--accent);
    text-decoration: underline;
  }
</style>
