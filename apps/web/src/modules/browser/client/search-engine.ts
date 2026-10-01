import { useCallback, useSyncExternalStore } from "react";

export const SEARCH_ENGINES = {
  google: { label: "Google", query: "https://www.google.com/search?q=" },
  duckduckgo: { label: "DuckDuckGo", query: "https://duckduckgo.com/?q=" },
  bing: { label: "Bing", query: "https://www.bing.com/search?q=" },
} as const;

export type SearchEngine = keyof typeof SEARCH_ENGINES;

// A choice about this computer's browser, like the other Devices settings, so
// it lives with the app on this machine rather than on the account.
const STORAGE_KEY = "chat.browser-search";
const listeners = new Set<() => void>();

const isEngine = (value: unknown): value is SearchEngine =>
  typeof value === "string" && Object.hasOwn(SEARCH_ENGINES, value);

export function readSearchEngine(): SearchEngine {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isEngine(stored) ? stored : "google";
  } catch {
    return "google";
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

export function useSearchEngine() {
  const engine = useSyncExternalStore(subscribe, readSearchEngine, readSearchEngine);
  const setEngine = useCallback((next: SearchEngine) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Without storage the choice lasts until the page reloads.
    }
    for (const listener of listeners) listener();
  }, []);
  return { engine, setEngine };
}
