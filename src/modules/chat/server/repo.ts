import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import { conversations, messageChunks, messages, messageToolCalls } from "~/db/schema/index.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import { ConversationNotFound } from "../errors.ts";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ChunkKind = "text" | "reasoning" | "tool";
export type ChunkRow = { seq: number; kind: ChunkKind; delta: string };
// Durable tool-call projection safe for clients (summaries only, no page bodies).
export type ToolCallRow = typeof messageToolCalls.$inferSelect;

export class ChatRepo extends Context.Service<
  ChatRepo,
  {
    listConversations(userId: string): Effect.Effect<ConversationRow[]>;
    getConversation(
      userId: string,
      conversationId: string,
    ): Effect.Effect<ConversationRow, ConversationNotFound>;
    createConversation(input: { userId: string; modelId: string }): Effect.Effect<ConversationRow>;
    updateConversation(
      conversationId: string,
      patch: Partial<{ title: string; modelId: string; lastMessageAt: Date }>,
    ): Effect.Effect<void>;
    deleteConversation(userId: string, conversationId: string): Effect.Effect<void>;
    listMessages(conversationId: string): Effect.Effect<MessageRow[]>;
    insertMessage(input: {
      conversationId: string;
      role: "user" | "assistant" | "system";
      status?: "streaming" | "complete";
      content?: string;
      modelId?: string;
    }): Effect.Effect<MessageRow>;
    getMessage(messageId: string): Effect.Effect<MessageRow | null>;
    appendChunks(
      messageId: string,
      chunks: ReadonlyArray<{ seq: number; kind: ChunkKind; delta: string }>,
    ): Effect.Effect<void>;
    chunksAfter(messageId: string, afterSeq: number): Effect.Effect<ChunkRow[]>;
    insertToolCall(input: {
      id: string;
      messageId: string;
      turnIndex: number;
      callIndex: number;
      providerCallId: string;
      toolName: string;
      arguments: JsonValue;
    }): Effect.Effect<void>;
    completeToolCall(input: {
      id: string;
      result: JsonValue;
      status: "complete" | "error";
      error?: { code: string; message: string };
    }): Effect.Effect<void>;
    // Marks calls stuck in "running" as failed (crash/fatal-error cleanup).
    failRunningToolCalls(messageId: string, message: string): Effect.Effect<void>;
    listToolCalls(messageIds: ReadonlyArray<string>): Effect.Effect<ToolCallRow[]>;
    finalizeMessage(input: {
      messageId: string;
      status: "complete" | "error" | "aborted";
      content: string;
      reasoning?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
      error?: { tag: string; message: string };
    }): Effect.Effect<void>;
    // Wipes a finished assistant message back to a fresh streaming state
    // (chunks, tool calls, content) so a retry can regenerate in place.
    resetMessageForRetry(messageId: string): Effect.Effect<void>;
    // Removes messages entirely (chunks/tool calls go via FK cascade).
    deleteMessages(messageIds: ReadonlyArray<string>): Effect.Effect<void>;
  }
>()("chat/chat/ChatRepo") {
  static readonly layer = Layer.effect(
    ChatRepo,
    Effect.gen(function* () {
      const db = yield* Db;

      return ChatRepo.of({
        listConversations: Effect.fn("ChatRepo.listConversations")(function* (userId) {
          return yield* db
            .select()
            .from(conversations)
            .where(eq(conversations.userId, userId))
            .orderBy(
              desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`),
            );
        }, Effect.orDie),

        getConversation: Effect.fn("ChatRepo.getConversation")(function* (userId, conversationId) {
          const rows = yield* db
            .select()
            .from(conversations)
            .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
            .pipe(Effect.orDie);
          const row = rows[0];
          if (!row) return yield* new ConversationNotFound({ conversationId });
          return row;
        }),

        createConversation: Effect.fn("ChatRepo.createConversation")(function* (input) {
          const rows = yield* db
            .insert(conversations)
            .values({ id: uuidv7(), userId: input.userId, modelId: input.modelId })
            .returning()
            .pipe(Effect.orDie);
          return rows[0]!;
        }),

        updateConversation: Effect.fn("ChatRepo.updateConversation")(
          function* (conversationId, patch) {
            yield* db
              .update(conversations)
              .set({ ...patch, updatedAt: new Date() })
              .where(eq(conversations.id, conversationId))
              .pipe(Effect.orDie);
          },
        ),

        deleteConversation: Effect.fn("ChatRepo.deleteConversation")(
          function* (userId, conversationId) {
            yield* db
              .delete(conversations)
              .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
              .pipe(Effect.orDie);
          },
        ),

        listMessages: Effect.fn("ChatRepo.listMessages")(function* (conversationId) {
          return yield* db
            .select()
            .from(messages)
            .where(eq(messages.conversationId, conversationId))
            .orderBy(asc(messages.createdAt))
            .pipe(Effect.orDie);
        }),

        insertMessage: Effect.fn("ChatRepo.insertMessage")(function* (input) {
          const rows = yield* db
            .insert(messages)
            .values({
              id: uuidv7(),
              conversationId: input.conversationId,
              role: input.role,
              status: input.status ?? "complete",
              content: input.content ?? "",
              modelId: input.modelId,
            })
            .returning()
            .pipe(Effect.orDie);
          return rows[0]!;
        }),

        getMessage: Effect.fn("ChatRepo.getMessage")(function* (messageId) {
          const rows = yield* db
            .select()
            .from(messages)
            .where(eq(messages.id, messageId))
            .pipe(Effect.orDie);
          return rows[0] ?? null;
        }),

        appendChunks: Effect.fn("ChatRepo.appendChunks")(function* (messageId, chunks) {
          if (chunks.length === 0) return;
          yield* db
            .insert(messageChunks)
            .values(chunks.map((c) => ({ messageId, seq: c.seq, kind: c.kind, delta: c.delta })))
            .pipe(Effect.orDie);
        }),

        chunksAfter: Effect.fn("ChatRepo.chunksAfter")(function* (messageId, afterSeq) {
          return yield* db
            .select({
              seq: messageChunks.seq,
              kind: messageChunks.kind,
              delta: messageChunks.delta,
            })
            .from(messageChunks)
            .where(and(eq(messageChunks.messageId, messageId), gt(messageChunks.seq, afterSeq)))
            .orderBy(asc(messageChunks.seq))
            .pipe(Effect.orDie);
        }),

        insertToolCall: Effect.fn("ChatRepo.insertToolCall")(function* (input) {
          yield* db
            .insert(messageToolCalls)
            .values({ ...input, status: "running" })
            .pipe(Effect.orDie);
        }),

        completeToolCall: Effect.fn("ChatRepo.completeToolCall")(function* (input) {
          yield* db
            .update(messageToolCalls)
            .set({
              result: input.result,
              status: input.status,
              error: input.error,
              completedAt: new Date(),
            })
            .where(eq(messageToolCalls.id, input.id))
            .pipe(Effect.orDie);
        }),

        failRunningToolCalls: Effect.fn("ChatRepo.failRunningToolCalls")(
          function* (messageId, message) {
            yield* db
              .update(messageToolCalls)
              .set({
                status: "error",
                error: { code: "GenerationFailed", message },
                completedAt: new Date(),
              })
              .where(
                and(
                  eq(messageToolCalls.messageId, messageId),
                  eq(messageToolCalls.status, "running"),
                ),
              )
              .pipe(Effect.orDie);
          },
        ),

        listToolCalls: Effect.fn("ChatRepo.listToolCalls")(function* (messageIds) {
          if (messageIds.length === 0) return [];
          return yield* db
            .select()
            .from(messageToolCalls)
            .where(inArray(messageToolCalls.messageId, [...messageIds]))
            .orderBy(
              asc(messageToolCalls.messageId),
              asc(messageToolCalls.turnIndex),
              asc(messageToolCalls.callIndex),
            )
            .pipe(Effect.orDie);
        }),

        finalizeMessage: Effect.fn("ChatRepo.finalizeMessage")(function* (input) {
          yield* db
            .update(messages)
            .set({
              status: input.status,
              content: input.content,
              reasoning: input.reasoning ?? "",
              usage: input.usage,
              error: input.error,
              completedAt: new Date(),
            })
            .where(eq(messages.id, input.messageId))
            .pipe(Effect.orDie);
        }),

        resetMessageForRetry: Effect.fn("ChatRepo.resetMessageForRetry")(function* (messageId) {
          yield* db
            .delete(messageChunks)
            .where(eq(messageChunks.messageId, messageId))
            .pipe(Effect.orDie);
          yield* db
            .delete(messageToolCalls)
            .where(eq(messageToolCalls.messageId, messageId))
            .pipe(Effect.orDie);
          yield* db
            .update(messages)
            .set({
              status: "streaming",
              content: "",
              reasoning: "",
              usage: null,
              error: null,
              completedAt: null,
            })
            .where(eq(messages.id, messageId))
            .pipe(Effect.orDie);
        }),

        deleteMessages: Effect.fn("ChatRepo.deleteMessages")(function* (messageIds) {
          if (messageIds.length === 0) return;
          yield* db
            .delete(messages)
            .where(inArray(messages.id, [...messageIds]))
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
