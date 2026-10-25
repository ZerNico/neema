import { getLocale, type Locale } from "~/paraglide/runtime.js";
import { findIntegrationType } from "./catalog.ts";

/**
 * A tool's title and transcript label in the reader's language. A shipped
 * tool has its own words for the page; a server's tools, and anything the
 * code no longer ships, keep the ones they came with.
 */
export const toolText = (
  kind: string | undefined,
  tool: { name: string; title?: string; label?: string },
  // The server passes the person's; the page reads its own.
  locale: Locale = getLocale(),
) => {
  const display = kind
    ? findIntegrationType(kind)?.tools.find((entry) => entry.name === tool.name)?.display
    : undefined;
  return {
    title: display?.title({}, { locale }) ?? tool.title ?? tool.name,
    label: display?.label({}, { locale }) ?? tool.label ?? tool.name,
  };
};
