import { SEARCH_ENGINES, type SearchEngine } from "./search-engine.ts";

// A bare host the way people type one: example.com, localhost:3000, 10.0.0.2/admin.
const HOST = /^(localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?([/?#]\S*)?$/i;

/**
 * What the address bar loads for what was typed: a web address as given, a
 * bare host over https, and anything else as a search. Other schemes (file:,
 * javascript:) are searched for, never opened.
 */
export function toAddress(input: string, engine: SearchEngine): string {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).href;
    } catch {
      // Not a parseable address after all: search for it.
    }
  } else if (HOST.test(text)) {
    try {
      return new URL(`https://${text}`).href;
    } catch {
      // Falls through to a search.
    }
  }
  return `${SEARCH_ENGINES[engine].query}${encodeURIComponent(text)}`;
}

/** The host a tab is on, for a title before the page names itself. */
export function hostOf(url: string): string | null {
  try {
    const { protocol, host } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? host : null;
  } catch {
    return null;
  }
}

/** What a page is called before and after it names itself. */
export const pageTitle = (title: string, url: string) => title || hostOf(url) || "New tab";
