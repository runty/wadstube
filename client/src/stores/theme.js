import { writable } from "svelte/store";

const STORAGE_KEY = "wadstube.theme.v1";
const modes = new Set(["system", "light", "dark"]);

function loadThemeMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return modes.has(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

function resolveTheme(mode, media) {
  if (mode !== "system") return mode;
  return media.matches ? "dark" : "light";
}

export const themeMode = writable(loadThemeMode());

export function setThemeMode(mode) {
  if (modes.has(mode)) themeMode.set(mode);
}

export function initTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let currentMode = "system";

  const apply = () => {
    document.documentElement.dataset.theme = resolveTheme(currentMode, media);
  };

  media.addEventListener("change", apply);

  themeMode.subscribe((mode) => {
    currentMode = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Persisting theme preference is best-effort.
    }
    apply();
  });
}
