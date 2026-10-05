import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY, themeInitScript } from "./boot-scripts.ts";
import { prefersReducedMotion } from "./reduced-motion.ts";

export type Theme = "light" | "dark" | "system";
export { themeInitScript };

const STORAGE_KEY = THEME_STORAGE_KEY;

function readTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

const willBeDark = (theme: Theme) =>
  theme === "dark" ||
  (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", willBeDark(theme));
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  // While in system mode, follow live OS appearance changes.
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- each subscriber needs its own listener, or one unsubscribe removes all
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
  const wasDark = document.documentElement.classList.contains("dark");
  const apply = () => applyTheme(theme);
  // A chosen switch crossfades the page. OS-driven changes in system mode stay
  // instant: nobody asked for them while looking. Browsers without view
  // transitions, and reduced motion, just switch.
  if (
    typeof document.startViewTransition === "function" &&
    !prefersReducedMotion() &&
    wasDark !== willBeDark(theme)
  )
    document.startViewTransition(apply);
  else apply();
  for (const listener of listeners) listener();
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => "system");
}
