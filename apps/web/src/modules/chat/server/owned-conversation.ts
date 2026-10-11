import { and, eq, isNull, sql, type Column } from "drizzle-orm";
import { conversations } from "~/db/schema/chat.ts";

/**
 * The chats a person owns and can still reach. A deleted chat waits out its
 * grace period as a row, so every reader that serves a person goes through
 * this, never a bare `userId` match. See docs/internals/deleted-chats.md.
 */
export const ownedConversation = (userId: string) =>
  and(eq(conversations.userId, userId), isNull(conversations.deletedAt));

/** One owned chat by id. */
export const ownedConversationById = (conversationId: string | Column, userId: string) =>
  and(eq(conversations.id, conversationId), ownedConversation(userId));

/**
 * A delete's mark as its Undo names it: `deleted_at` in UTC to the
 * microsecond, in a form no session setting changes and that casts back
 * exactly. A JS Date would round the microseconds away.
 */
export const deleteMark = sql<string>`to_char(${conversations.deletedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
