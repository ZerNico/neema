import { Effect, Schema } from "effect";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { defineTool, refused, result } from "./define.ts";

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));

export const chatUrl = (origin: string, chatId: string) => `${origin}/chat/${chatId}`;

/** The list's keyset position, opaque to the caller. */
const encodeCursor = (cursor: { activity: Date; id: string }) =>
  Buffer.from(JSON.stringify({ a: cursor.activity.toISOString(), i: cursor.id })).toString(
    "base64url",
  );

const decodeCursor = (raw: string) => {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (
      typeof value === "object" &&
      value !== null &&
      "a" in value &&
      "i" in value &&
      typeof value.a === "string" &&
      typeof value.i === "string" &&
      !Number.isNaN(Date.parse(value.a))
    )
      return { activity: new Date(value.a), id: value.i };
  } catch {
    // An unreadable cursor is answered below like any other bad one.
  }
  return null;
};

export const listChats = defineTool({
  name: "list_chats",
  title: "List chats",
  description:
    "This person's recent chats, newest activity first, as the sidebar lists them (temporary and archived chats are left out). A Work chat can be read here but continues only in the desktop app. Pass `cursor` from a previous answer for the next page.",
  scope: "chats:read",
  input: Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Limit),
    cursor: Schema.optionalKey(Schema.String),
  }),
  annotations: readOnly,
  run: (args, { principal, origin }) =>
    Effect.gen(function* () {
      const cursor = args.cursor === undefined ? undefined : decodeCursor(args.cursor);
      if (cursor === null) return yield* refused("That cursor is not one this server gave out.");
      const page = yield* ChatRepo.use((repo) =>
        repo.listConversations({
          userId: principal.userId,
          limit: args.limit ?? 20,
          query: args.query,
          ...(cursor ? { cursor } : {}),
        }),
      );
      const chats = page.conversations.map((chat) => ({
        id: chat.id,
        title: chat.title ?? "Untitled",
        projectId: chat.projectId,
        // A Work chat goes on only in the desktop app, beside its files.
        work: chat.mode === "work",
        lastActivity: (chat.lastMessageAt ?? chat.createdAt).toISOString(),
        generating: chat.generating,
        url: chatUrl(origin, chat.id),
      }));
      const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;
      const lines = chats.map(
        (c) =>
          `- ${c.title} (${c.id}), ${c.lastActivity}${c.work ? ", Work chat (desktop app only)" : ""}${c.generating ? ", answering now" : ""}`,
      );
      if (nextCursor) lines.push(`More: cursor ${nextCursor}`);
      return result(lines.length ? lines.join("\n") : "No chats.", { chats, nextCursor });
    }),
});

export const searchChats = defineTool({
  name: "search_chats",
  title: "Search chats",
  description:
    "Finds this person's chats by title and message text, archived ones included, most recent first. Each hit names its chat and, when text matched, the message and an excerpt.",
  scope: "chats:read",
  input: Schema.Struct({
    query: Schema.String,
    limit: Schema.optionalKey(Limit),
  }),
  annotations: readOnly,
  run: (args, { principal, origin }) =>
    Effect.gen(function* () {
      if (!args.query.trim()) return yield* refused("Give a query to search for.");
      const hits = yield* ChatRepo.use((repo) =>
        repo.searchConversations({
          userId: principal.userId,
          query: args.query,
          limit: args.limit ?? 10,
        }),
      );
      const rows = hits.map((hit) => ({
        chatId: hit.conversationId,
        title: hit.title ?? "Untitled",
        messageId: hit.messageId,
        excerpt: hit.snippet?.text ?? null,
        archived: hit.archived,
        url: chatUrl(origin, hit.conversationId),
      }));
      const text = rows.length
        ? rows
            .map(
              (r) =>
                `- ${r.title} (${r.chatId})${r.archived ? " [archived]" : ""}${r.excerpt ? `: ${r.excerpt}` : ""}`,
            )
            .join("\n")
        : "No chats match.";
      return result(text, { hits: rows });
    }),
});
