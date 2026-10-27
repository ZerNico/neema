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

/**
 * What an approval asks to do. A shipped tool's title says it as an action; its
 * label says what happened, for the transcript, and would ask "Sent … in Outlook?".
 * A server's tool has no title on the call, so its own label stands in.
 */
export const approvalAction = (
  kind: string | undefined,
  call: { tool: string; label: string },
  locale: Locale = getLocale(),
) => toolText(kind, { name: call.tool, title: call.label, label: call.label }, locale).title;
