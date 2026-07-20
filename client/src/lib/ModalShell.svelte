<script>
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { focusReturnTarget, isUsableFocusTarget, modalFocusFallback } from "../stores/modal.js";
  export let id;
  export let title;
  export let onClose;
  export let wide = false;
  let dialog;
  let closeButton;
  let returnFocus;

  const selector = "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])";
  onMount(() => {
    returnFocus = document.activeElement;
    queueMicrotask(() => closeButton?.focus());
    return () => {
      const fallback = get(modalFocusFallback);
      const target = focusReturnTarget(returnFocus, fallback);
      target?.focus?.();
      modalFocusFallback.set(null);
    };
  });
  function keydown(event) {
    if (event.key === "Escape") { event.preventDefault(); onClose?.(); return; }
    if (event.key !== "Tab") return;
    const items = [...dialog.querySelectorAll(selector)]
      .filter((node) => node.getAttribute("aria-hidden") !== "true" && isUsableFocusTarget(node));
    if (!items.length) { event.preventDefault(); dialog.focus(); return; }
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
</script>

<button class="modal-backdrop" type="button" aria-label={`Close ${title}`} on:click={() => onClose?.()}></button>
<div {id} class:wide class="modal-shell" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
  tabindex="-1" bind:this={dialog} on:keydown={keydown}>
  <header class="modal-header">
    <div><h2 id={`${id}-title`}>{title}</h2><slot name="subtitle" /></div>
    <button class="modal-close" type="button" bind:this={closeButton} on:click={() => onClose?.()} aria-label={`Close ${title}`}>×</button>
  </header>
  <div class="modal-body"><slot /></div>
  {#if $$slots.footer}<footer class="modal-footer"><slot name="footer" /></footer>{/if}
</div>

<style>
  .modal-backdrop { position: fixed; inset: 0; border: 0; background: var(--overlay); z-index: 250; }
  .modal-shell { position: fixed; z-index: 260; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(620px, 94vw); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }
  .modal-shell.wide { width: min(1040px, 96vw); }
  .modal-header, .modal-footer { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .modal-footer { border-bottom: 0; border-top: 1px solid var(--border); justify-content: flex-end; flex-wrap: wrap; }
  .modal-header h2 { margin: 0; color: var(--heading); font-size: 1.2rem; }
  .modal-header :global(p) { color: var(--text-muted); font-size: .8rem; margin: 3px 0 0; }
  .modal-close { margin-left: auto; border: 0; background: transparent; color: var(--text); font-size: 1.6rem; padding: 4px 10px; cursor: pointer; }
  .modal-body { overflow: auto; padding: 16px 18px; }
</style>
