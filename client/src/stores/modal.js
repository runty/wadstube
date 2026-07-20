import { writable } from "svelte/store";

export const modalFocusFallback = writable(null);

export function isUsableFocusTarget(node) {
  if (!node || !node.isConnected || node.disabled || node.hidden || node.tabIndex < 0) return false;
  if (node.inert || node.closest?.("[hidden], [inert]")) return false;
  const style = globalThis.getComputedStyle?.(node);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false;
  return true;
}

export function focusReturnTarget(captured, fallback) {
  if (isUsableFocusTarget(captured)) return captured;
  return isUsableFocusTarget(fallback) ? fallback : null;
}
