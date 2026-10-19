import { BubbleChatIcon, BubbleChatSearchIcon } from "@hugeicons/core-free-icons";
import { cn } from "~/ui/utils";
import type { HistoryToolActivity } from "../client/use-message-stream.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const messages = (from: number | undefined, to: number | undefined) =>
  from === undefined || to === undefined
    ? "earlier messages"
    : from === to
      ? `message ${from}`
      : `messages ${from}–${to}`;

/** The row's line: what was looked for, where, and what came back. */
function historyActivityLabel(activity: HistoryToolActivity) {
  const read = activity.read;
  const running = activity.status === "running";
  if (activity.name === "search_chats") {
    if (running) return "Searching your other chats";
    if (!read?.ok) return "Couldn’t search your other chats";
    const matches = read.matches ?? 0;
    return matches
      ? `Found ${count(matches, "chat", "chats")} for “${read.query}”`
      : `No chats found for “${read.query}”`;
  }
  if (activity.name === "read_chat") {
    if (running) return "Reading another chat";
    if (!read?.ok) return "Couldn’t read the chat";
    const title = read.chatTitle ? `“${read.chatTitle}”` : "another chat";
    return read.total !== undefined &&
      read.to !== undefined &&
      read.to - (read.from ?? 1) + 1 < read.total
      ? `Read ${messages(read.from, read.to)} of ${title}`
      : `Read ${title}`;
  }
  if (running) return "Looking back in this chat";
  if (!read?.ok) return "Couldn’t look back in this chat";
  if (read.query !== undefined) {
    const matches = read.matches ?? 0;
    return matches
      ? `Found ${count(matches, "earlier message", "earlier messages")} for “${read.query}”`
      : `No earlier messages found for “${read.query}”`;
  }
  return `Read ${messages(read.from, read.to)} of this chat`;
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
