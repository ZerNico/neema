import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { models } from "./providers.ts";
import type { JsonValue } from "./providers.ts";
import { user } from "./auth.ts";

export const conversations = pgTable(
  "conversations",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text().notNull().default("New chat"),
    modelId: text("model_id").references(() => models.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (t) => [
    index("conversations_user_id_idx").on(t.userId),
    index("conversations_last_message_at_idx").on(t.lastMessageAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text({ enum: ["user", "assistant", "system"] }).notNull(),
    // assistant messages stream; user/system messages are born complete
    status: text({ enum: ["streaming", "complete", "error", "aborted"] })
      .notNull()
      .default("complete"),
    // final assembled text; for streaming messages this is written on completion
    content: text().notNull().default(""),
    // final assembled reasoning/thinking text; empty for non-reasoning models
    reasoning: text().notNull().default(""),
    modelId: text("model_id").references(() => models.id, { onDelete: "set null" }),
    usage: jsonb().$type<{ inputTokens?: number; outputTokens?: number }>(),
    error: jsonb().$type<{ tag: string; message: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("messages_conversation_id_idx").on(t.conversationId)],
);

// Ordered stream chunks for resumable replay. Retained until the message is
// complete + a grace period (cleanup job), so late resumers can still replay.
export const messageChunks = pgTable(
  "message_chunks",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    seq: bigint({ mode: "number" }).notNull(),
    // what the delta belongs to: the visible answer, the reasoning trace, or a
    // tool activity marker (JSON envelope in delta)
    kind: text({ enum: ["text", "reasoning", "tool"] })
      .notNull()
      .default("text"),
    delta: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.seq] })],
);

// Durable record of tool calls made during an assistant message's generation.
// Stores query/summary metadata only — extracted page bodies are passed to the
// model in-memory and never persisted.
export const messageToolCalls = pgTable(
  "message_tool_calls",
  {
    id: text().primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    // one displayed assistant message can span several model turns
    turnIndex: integer("turn_index").notNull(),
    callIndex: integer("call_index").notNull(),
    // id the provider assigned; must be echoed back in the tool-result message
    providerCallId: text("provider_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    arguments: jsonb().$type<JsonValue>().notNull(),
    // durable summary (query, counts, source urls/titles) — not page content
    result: jsonb().$type<JsonValue>(),
    status: text({ enum: ["running", "complete", "error"] }).notNull(),
    error: jsonb().$type<{ code: string; message: string }>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("message_tool_calls_message_id_idx").on(t.messageId),
    uniqueIndex("message_tool_calls_turn_call_idx").on(t.messageId, t.turnIndex, t.callIndex),
  ],
);
