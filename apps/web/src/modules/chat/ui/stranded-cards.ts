import type { ToolActivity } from "../client/use-message-stream.ts";
import { PLACED_CALL_PREFIX } from "./live-message.ts";
import type { DisplayMessage } from "./message-list.tsx";

/** Something the transcript should show a card for, but no tool row names yet. */
export interface Stranded {
  /** Names what the card shows, so an unchanged host row keeps its placed copy. */
  key: string;
  /** The answer that created it, when known. */
  messageId: string | null | undefined;
  activity: (message: DisplayMessage, index: number) => ToolActivity;
}

/**
 * Puts a card with no tool row of its own at the end of the answer that made
 * it: a document whose `create_document` row predates the column, or a draft
 * the loader reports before the tool rows arrive. Never under the transcript,
 * where it would read as belonging to the whole chat.
 */
export function placeStranded(
  messages: DisplayMessage[],
  stranded: ReadonlyArray<Stranded>,
  /** Older turns are not loaded, so an unknown answer may simply be further up. */
  partial: boolean,
) {
  if (stranded.length === 0) return messages;
  const answers = messages.filter((message) => message.role === "assistant");
  const fallback = answers.at(-1)?.id;
  const byMessage = new Map<string, Stranded[]>();
  for (const item of stranded) {
    const anchor = item.messageId;
    const loaded = !!anchor && answers.some((message) => message.id === anchor);
    // Its answer is somewhere above: it appears there once that page loads.
    if (anchor && !loaded && partial) continue;
    const host = loaded ? anchor : fallback;
    if (!host) continue;
    const list = byMessage.get(host);
    if (list) list.push(item);
    else byMessage.set(host, [item]);
  }
  if (byMessage.size === 0) return messages;
  return messages.map((message) => {
    const items = byMessage.get(message.id);
    if (!items) return message;
    const key = items.map((item) => item.key).join("\n");
    const cached = placedRows.get(message);
    if (cached?.key === key) return cached.row;
    const row = {
      ...message,
      toolActivities: [
        ...message.toolActivities,
        ...items.map((item, index) => item.activity(message, index)),
      ],
    };
    placedRows.set(message, { key, row });
    return row;
  });
}

/**
 * A host row with its placed cards, kept while neither changes: the display is
 * rebuilt on every live chunk, and a new copy would re-render a settled answer.
 */
const placedRows = new WeakMap<DisplayMessage, { key: string; row: DisplayMessage }>();

/** The ids a family's rows already show, so only the rest need placing. */
export const shownIds = (
  messages: DisplayMessage[],
  pick: (activity: ToolActivity) => string | undefined,
) => new Set(messages.flatMap((message) => message.toolActivities.flatMap((a) => pick(a) ?? [])));

export const placed = (message: DisplayMessage, index: number, id: string) => ({
  status: "complete" as const,
  callId: `${PLACED_CALL_PREFIX}${id}`,
  turnIndex: Number.MAX_SAFE_INTEGER,
  callIndex: index,
  textOffset: message.content.length,
});
