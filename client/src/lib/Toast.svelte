<script>
  import { toast } from "../stores/feed.js";

  let timeout;

  $: if ($toast) {
    clearTimeout(timeout);
    timeout = setTimeout(() => toast.set(null), 3000);
  }
</script>

{#if $toast}
  <div class="toast"
       class:success={$toast.type === "success"}
       class:error={$toast.type === "error"}
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
    font-size: 0.85rem;
    z-index: 400;
    animation: slideUp 0.2s ease;
    max-width: 90%;
    text-align: center;
  }
  .success {
    background: #2d7a3a;
    color: #fff;
  }
  .error {
    background: #cc3333;
    color: #fff;
  }
  .info {
    background: #444;
    color: #fff;
  }
  @keyframes slideUp {
    from { transform: translateX(-50%) translateY(20px); opacity: 0; }
    to { transform: translateX(-50%) translateY(0); opacity: 1; }
  }
</style>
