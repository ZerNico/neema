import { useSyncExternalStore } from "react";
import {
  COLOR_SCHEMES,
  SCHEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  themeInitScript,
} from "./boot-scripts.ts";
import { prefersReducedMotion } from "./reduced-motion.ts";

export type Theme = "light" | "dark" | "system";
export { COLOR_SCHEMES, themeInitScript };

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

export type ColorScheme = (typeof COLOR_SCHEMES)[number];

const schemeListeners = new Set<() => void>();

function readColorScheme(): ColorScheme {
  if (typeof window === "undefined") return COLOR_SCHEMES[0];
  const stored = localStorage.getItem(SCHEME_STORAGE_KEY);
  return COLOR_SCHEMES.find((scheme) => scheme === stored) ?? COLOR_SCHEMES[0];
}

export function setColorScheme(scheme: ColorScheme) {
  if (scheme === COLOR_SCHEMES[0]) localStorage.removeItem(SCHEME_STORAGE_KEY);
  else localStorage.setItem(SCHEME_STORAGE_KEY, scheme);
  const apply = () => {
    document.documentElement.dataset.scheme = scheme;
  };
  if (typeof document.startViewTransition === "function" && !prefersReducedMotion())
    document.startViewTransition(apply);
  else apply();
  for (const listener of schemeListeners) listener();
}

function subscribeToScheme(listener: () => void) {
  schemeListeners.add(listener);
  return () => {
    schemeListeners.delete(listener);
  };
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeToScheme, readColorScheme, () => COLOR_SCHEMES[0]);
}
