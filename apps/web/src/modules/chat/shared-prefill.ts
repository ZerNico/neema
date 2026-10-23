import { readChatPrefill } from "~/modules/agents/authoring.ts";

/** The longest draft a prefill carries; anything shared past it is cut, not refused. */
const MAX = 2_000;

/**
 * What another app shared, as one draft. Apps fill the three fields
 * differently: a browser sends the page's title and address, a notes app only
 * text, and many put the address inside the text too, so it is not repeated.
 */
export function sharedPrefill(shared: {
  title?: string | undefined;
  text?: string | undefined;
  url?: string | undefined;
}): string | null {
  const title = shared.title?.trim() ?? "";
  const text = shared.text?.trim() ?? "";
  const url = shared.url?.trim() ?? "";
  const parts = [
    title && !text.includes(title) ? title : "",
    text,
    url && !text.includes(url) ? url : "",
  ].filter(Boolean);
  const joined = parts.join("\n\n");
  return readChatPrefill(joined.length > MAX ? `${joined.slice(0, MAX - 1)}…` : joined);
}
