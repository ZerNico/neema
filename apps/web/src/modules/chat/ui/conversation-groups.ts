// Sidebar bucketing by recency. The server already orders conversations
// newest-first, so grouping only has to slice that order and never reorder it.

export interface DatedConversation {
  readonly lastMessageAt: Date | string | number | null;
  readonly createdAt: Date | string | number;
}

export interface ConversationGroup<T> {
  readonly label: string;
  readonly conversations: ReadonlyArray<T>;
}

// A chat with no messages yet is still "from" the moment it was created.
const activityOf = (conversation: DatedConversation): Date =>
  new Date(conversation.lastMessageAt ?? conversation.createdAt);

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const DAY_MS = 86_400_000;

// Calendar days, not elapsed hours: something from 23:00 yesterday reads as
// "Yesterday" at 08:00, which is what a person means by it.
const labelFor = (activity: Date, today: number): string => {
  const time = activity.getTime();
  if (Number.isNaN(time) || time >= today) return "Today";
  if (time >= today - DAY_MS) return "Yesterday";
  if (time >= today - 6 * DAY_MS) return "Previous 7 days";
  if (time >= today - 29 * DAY_MS) return "Previous 30 days";
  return "Older";
};

/**
 * Splits an already newest-first list into contiguous recency runs. Labels
 * appear in the order they are first reached, so the result stays a faithful
 * partition of the input even if the ordering assumption is ever violated.
 */
export function groupConversationsByDate<T extends DatedConversation>(
  conversations: ReadonlyArray<T>,
  now: Date = new Date(),
): ReadonlyArray<ConversationGroup<T>> {
  const today = startOfDay(now);
  const groups: Array<{ label: string; conversations: T[] }> = [];
  for (const conversation of conversations) {
    const label = labelFor(activityOf(conversation), today);
    const current = groups.at(-1);
    if (current?.label === label) current.conversations.push(conversation);
    else groups.push({ label, conversations: [conversation] });
  }
  return groups;
}
