import { uuidv7 } from "uuidv7";
import type { AssistantOutput } from "~/modules/chat/assistant-output.ts";
import type { ProviderReplay } from "~/modules/chat/server/provider-replay.ts";
import { desc, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
    // Null until the first turn's generated title lands; the sidebar shows a
    // pending placeholder for it. Never reset to null once resolved.
    title: text(),
    modelId: text("model_id").references(() => models.id, { onDelete: "set null" }),
    // Set when this conversation was forked off another one at some message.
    // Lineage is a display detail, so losing the source loses the marker
    // rather than the branch; the annotation breaks the self-reference cycle
    // TypeScript cannot infer its way out of.
    branchedFrom: text("branched_from").references((): AnyPgColumn => conversations.id, {
      onDelete: "set null",
    }),
    // Fixed at creation, like the agent association. A work chat can reach
    // folders on the user's machine; a browser tab can only read it. A folder
    // is invited, not required: tools stay withheld until one is attached.
    mode: text({ enum: ["chat", "work"] })
      .notNull()
      .default("chat"),
    // How much a work chat asks before acting. Policy is a fact about the
    // chat, not the machine, so it lives here and every device honours the
    // same choice; the folder path is the one thing that stays on the machine.
    permissionLevel: text("permission_level", { enum: ["manual", "auto", "skip"] })
      .notNull()
      .default("auto"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /**
     * Set when a schedule fired this conversation into existence. Such chats
     * are hidden from the sidebar list and reached from the schedule's page;
     * deleting the schedule takes its run conversations with it. Declared
     * without a reference to avoid a schema import cycle (chat -> schedules ->
     * chat); the FK constraint lives in the migration.
     */
    scheduleId: text("schedule_id"),
  },
  (t) => [
    index("conversations_user_id_idx").on(t.userId),
    // Postgres does not index the referencing side of a foreign key, and
    // `on delete set null` scans it for every deleted conversation.
    index("conversations_branched_from_idx").on(t.branchedFrom),
    index("conversations_last_message_at_idx").on(t.lastMessageAt),
    // Postgres does not index the referencing side of a foreign key, and
    // `on delete cascade` from schedules scans it for every deleted schedule.
    index("conversations_schedule_id_idx").on(t.scheduleId),
    // Serves the sidebar's keyset paging, which orders by exactly this
    // expression pair (see ChatRepo.listConversations).
    index("conversations_user_activity_idx").on(
      t.userId,
      sql`coalesce(${t.lastMessageAt}, ${t.createdAt}) desc`,
      desc(t.id),
    ),
  ],
);

export const workTurnReservations = pgTable(
  "work_turn_reservations",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    intent: text({ enum: ["new", "existing"] }).notNull(),
    status: text({ enum: ["reserved", "activated", "aborted", "expired"] })
      .notNull()
      .default("reserved"),
    assistantMessageId: text("assistant_message_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("work_turn_reservations_user_id_idx").on(t.userId),
    index("work_turn_reservations_expiry_idx").on(t.expiresAt),
    uniqueIndex("work_turn_reservations_live_conversation_idx")
      .on(t.conversationId)
      .where(sql`${t.status} = 'reserved'`),
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
    // Structured answer; content is its server-generated model/provenance projection.
    generationId: text("generation_id").$defaultFn(uuidv7),
    // Heartbeat for a streaming ordinary generation, renewed by the owning
    // fiber's periodic flush. Null while streaming means a process died before
    // its first flush; the reaper terminalizes both cases. Research keeps its
    // own lease on research_runs.
    generationLeaseUntil: timestamp("generation_lease_until", { withTimezone: true }),
    assistantOutput: jsonb("assistant_output").$type<AssistantOutput>(),
    providerReplay: jsonb("provider_replay").$type<ProviderReplay>(),
    questionResponse: jsonb("question_response").$type<JsonValue>(),
    // final assembled reasoning/thinking text; empty for non-reasoning models
    reasoning: text().notNull().default(""),
    modelId: text("model_id").references(() => models.id, { onDelete: "set null" }),
    usage: jsonb().$type<{
      inputTokens?: number;
      outputTokens?: number;
      /**
       * Input tokens the provider counted for the FIRST model call of this
       * generation, the only number that maps onto one prompt. `inputTokens`
       * sums every tool round, so it cannot calibrate the estimator.
       */
      firstInputTokens?: number;
      /** What the estimator predicted for that same prompt. */
      estimatedFirstInputTokens?: number;
    }>(),
    error: jsonb().$type<{ tag: string; message: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Set when a user edits their message; null means never edited. createdAt
    // stays untouched so conversation ordering is stable.
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  (t) => [
    index("messages_conversation_id_idx").on(t.conversationId),
    // Serves the total conversation order `(created_at, id)`. Timestamps
    // collide within a turn; uuidv7 ids break the tie in insertion order, and
    // compaction boundaries are positions in exactly this sequence.
    index("messages_conversation_order_idx").on(t.conversationId, t.createdAt, t.id),
    index("messages_streaming_lease_idx")
      .on(t.generationLeaseUntil)
      .where(sql`${t.status} = 'streaming'`),
  ],
);

/**
 * Ordered stream chunks for resumable replay. Retained until the message is
 * complete + a grace period (cleanup job), so late resumers can still replay.
 */
export const messageChunks = pgTable(
  "message_chunks",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    seq: bigint({ mode: "number" }).notNull(),
    // what the delta belongs to: the visible answer, the reasoning trace, or a
    // tool/compaction activity marker (JSON envelope in delta). Plain text
    // column, so a new marker kind is a TypeScript change only.
    kind: text({ enum: ["text", "reasoning", "tool", "compaction", "file"] })
      .notNull()
      .default("text"),
    delta: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.seq] })],
);

/**
 * Durable record of tool calls made during an assistant message's generation.
 * Stores query/summary metadata only, since extracted page bodies are passed to the
 * model in-memory and never persisted.
 */
export const messageToolCalls = pgTable(
  "message_tool_calls",
  {
    id: text().primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    researchRunId: text("research_run_id"),
    researchTaskId: text("research_task_id"),
    // one displayed assistant message can span several model turns
    turnIndex: integer("turn_index").notNull(),
    callIndex: integer("call_index").notNull(),
    // UTF-16 offset in the original message content at invocation; null for legacy rows.
    textOffset: integer("text_offset"),
    // id the provider assigned; must be echoed back in the tool-result message
    providerCallId: text("provider_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    arguments: jsonb().$type<JsonValue>().notNull(),
    // durable summary (query, counts, source urls/titles), not page content
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

/**
 * Progressive compaction checkpoints (Onyx-style): the summary that stands in
 * for everything up to and including `through_message_id` when a conversation
 * outgrows the model's context window. The stored transcript is never touched,
 * only the model payload is compacted.
 *
 * Rows are immutable and superseded rather than replaced: a branch cut before
 * the newest boundary still needs the newest checkpoint that is valid for its
 * own prefix. "Valid" is decided by position in the ordered message list, so
 * a checkpoint whose boundary message is gone (cascade) is simply gone too.
 */
export const conversationCompactionCheckpoints = pgTable(
  "conversation_compaction_checkpoints",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // Deleting the boundary message invalidates the summary that ends there:
    // there is no longer a position it could describe.
    throughMessageId: text("through_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    // Which model wrote the summary; losing the row loses the attribution only.
    modelId: text("model_id").references(() => models.id, { onDelete: "set null" }),
    summary: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("compaction_checkpoints_conversation_through_idx").on(
      t.conversationId,
      t.throughMessageId,
    ),
    // Referencing side of the FK, scanned on every message delete.
    index("compaction_checkpoints_through_message_idx").on(t.throughMessageId),
  ],
);

/**
 * Durable UI occurrences of context compaction. Checkpoints describe prompt
 * state; these rows describe when a particular assistant generation performed
 * the work, so timeline placement never has to be inferred from a checkpoint
 * boundary. Active-round events deliberately have no checkpoint.
 */
export const messageCompactionEvents = pgTable(
  "message_compaction_events",
  {
    id: text().primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    researchRunId: text("research_run_id"),
    researchTaskId: text("research_task_id"),
    checkpointId: text("checkpoint_id").references(() => conversationCompactionCheckpoints.id, {
      onDelete: "set null",
    }),
    // The event happened after every model turn below this index and before
    // this turn. Initial history compaction therefore uses 0.
    beforeTurnIndex: integer("before_turn_index").notNull(),
    // Several reductions may be needed before the same model turn.
    passIndex: integer("pass_index").notNull(),
    textOffset: integer("text_offset"),
    scope: text({ enum: ["history", "active_rounds"] }).notNull(),
    status: text({ enum: ["running", "complete", "error"] }).notNull(),
    outcome: text({ enum: ["summary", "hard_truncation"] }),
    summary: text(),
    error: jsonb().$type<{ code: string; message: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("message_compaction_events_position_idx").on(
      t.messageId,
      t.beforeTurnIndex,
      t.passIndex,
    ),
    index("message_compaction_events_message_id_idx").on(t.messageId),
    index("message_compaction_events_checkpoint_id_idx").on(t.checkpointId),
  ],
);
