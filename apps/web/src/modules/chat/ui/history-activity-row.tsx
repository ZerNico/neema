import { m } from "~/paraglide/messages.js";
import { BubbleChatIcon, BubbleChatSearchIcon } from "@hugeicons/core-free-icons";
import { cn } from "~/ui/utils";
import type { HistoryToolActivity } from "../client/use-message-stream.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

type Range = { number: number } | { from: number; to: number } | null;

const rangeOf = (from: number | undefined, to: number | undefined): Range =>
  from === undefined || to === undefined ? null : from === to ? { number: from } : { from, to };

/** "Read messages 3–5 of …", where "…" is a titled chat, another chat, or this one. */
const readPart = (
  range: Range,
  words: {
    one: (inputs: { number: number }) => string;
    span: (inputs: { from: number; to: number }) => string;
    earlier: () => string;
  },
) => (range === null ? words.earlier() : "number" in range ? words.one(range) : words.span(range));

/** The row's line: what was looked for, where, and what came back. */
function historyActivityLabel(activity: HistoryToolActivity) {
  const read = activity.read;
  const running = activity.status === "running";
  if (activity.name === "search_chats") {
    if (running) return m.chat_history_searching();
    if (!read?.ok) return m.chat_history_search_failed();
    const matches = read.matches ?? 0;
    const query = read.query ?? "";
    return matches
      ? m.chat_history_found_chats({ count: matches, query })
      : m.chat_history_no_chats({ query });
  }
  if (activity.name === "read_chat") {
    if (running) return m.chat_history_reading_chat();
    if (!read?.ok) return m.chat_history_read_chat_failed();
    const title = read.chatTitle;
    const partial =
      read.total !== undefined &&
      read.to !== undefined &&
      read.to - (read.from ?? 1) + 1 < read.total;
    if (!partial)
      return title ? m.chat_history_read_titled({ title }) : m.chat_history_read_other();
    const range = rangeOf(read.from, read.to);
    return title
      ? readPart(range, {
          one: ({ number }) => m.chat_history_read_message_titled({ number, title }),
          span: ({ from, to }) => m.chat_history_read_messages_titled({ from, to, title }),
          earlier: () => m.chat_history_read_earlier_titled({ title }),
        })
      : readPart(range, {
          one: m.chat_history_read_message_other,
          span: m.chat_history_read_messages_other,
          earlier: m.chat_history_read_earlier_other,
        });
  }
  if (running) return m.chat_history_looking_back();
  if (!read?.ok) return m.chat_history_look_back_failed();
  if (read.query !== undefined) {
    const matches = read.matches ?? 0;
    return matches
      ? m.chat_history_found_earlier({ count: matches, query: read.query })
      : m.chat_history_no_earlier({ query: read.query });
  }
  return readPart(rangeOf(read.from, read.to), {
    one: m.chat_history_read_message_here,
    span: m.chat_history_read_messages_here,
    earlier: m.chat_history_read_earlier_here,
  });
}

/** One line per call, never the text it read. */
export function HistoryActivityRow({ activity }: { activity: HistoryToolActivity }) {
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <ActivityFace
        icon={activity.name === "search_chats" ? BubbleChatSearchIcon : BubbleChatIcon}
        label={historyActivityLabel(activity)}
        status={
          activity.status === "running"
            ? "running"
            : activity.read?.ok === false || activity.status === "error"
              ? "failed"
              : "done"
        }
      />
    </div>
  );
}
