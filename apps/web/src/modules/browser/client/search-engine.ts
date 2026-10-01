import { localPreference } from "./preference.ts";

export const SEARCH_ENGINES = {
  google: { label: "Google", query: "https://www.google.com/search?q=" },
  duckduckgo: { label: "DuckDuckGo", query: "https://duckduckgo.com/?q=" },
  bing: { label: "Bing", query: "https://www.bing.com/search?q=" },
} as const;

export type SearchEngine = keyof typeof SEARCH_ENGINES;

const searchEngine = localPreference<SearchEngine>(
  "chat.browser-search",
  ["google", "duckduckgo", "bing"],
  "google",
);

export const readSearchEngine = searchEngine.read;

export function useSearchEngine() {
  const [engine, setEngine] = searchEngine.use();
  return { engine, setEngine };
}

/** Where a web link clicked in a chat opens: the side panel, or the computer's own browser. */
export type LinkTarget = "panel" | "external";

const linkTarget = localPreference<LinkTarget>(
  "chat.browser-links",
  ["panel", "external"],
  "panel",
);

export const readLinkTarget = linkTarget.read;
export const useLinkTarget = linkTarget.use;
