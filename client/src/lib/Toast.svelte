<script>
  import { toast } from "../stores/feed.js";

  let timeout;

  $: if ($toast) {
    clearTimeout(timeout);
    timeout = setTimeout(() => toast.set(null), $toast.durationMs ?? 3000);
  }
</script>

{#if $toast}
  <div class="toast" role="status" aria-live="polite"
       class:success={$toast.type === "success"}
       class:error={$toast.type === "error"}
       class:warning={$toast.type === "warning"}
       class:info={$toast.type === "info"}>
    {$toast.message}
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    padding: 10px 24px;
    border-radius: 8px;
    box-shadow: var(--shadow);
    font-size: 0.85rem;
    font-weight: 700;
    z-index: 400;
    animation: slideUp 0.2s ease;
    max-width: 90%;
    text-align: center;
  }
  .success {
    background: var(--good);
    color: #06140f;
  }
  .error {
    background: var(--danger);
    color: #fff;
  }
  .warning {
    background: var(--accent);
    color: var(--ink);
  }
  .info {
    background: var(--card-bg);
    border: 1px solid var(--border);
    color: var(--heading);
  }
  @keyframes slideUp {
    from { transform: translateX(-50%) translateY(20px); opacity: 0; }
    to { transform: translateX(-50%) translateY(0); opacity: 1; }
  }
</style>
