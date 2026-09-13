import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY, themeInitScript } from "./boot-scripts.ts";

export type Theme = "light" | "dark" | "system";
export { themeInitScript };

const STORAGE_KEY = THEME_STORAGE_KEY;

function readTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  // While in system mode, follow live OS appearance changes.
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onMedia = () => {
    if (readTheme() === "system") applyTheme("system");
  };
  media.addEventListener("change", onMedia);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onMedia);
  };
}

export function setTheme(theme: Theme) {
  if (theme === "system") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
  for (const listener of listeners) listener();
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => "system");
}
