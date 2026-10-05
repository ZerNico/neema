import type { MentionItem } from "./mention-list.tsx";

const MAX_RESULTS = 8;

export const filterMentionItems = (items: readonly MentionItem[], query: string) =>
  items
    .filter((item) =>
      (item.search ?? `${item.label} ${item.description ?? ""}`)
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, MAX_RESULTS);
