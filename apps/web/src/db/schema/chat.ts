import { uuidv7 } from "uuidv7";
import type { AssistantOutput } from "~/modules/chat/assistant-output.ts";
import type { FileReferenceAliases } from "~/modules/chat/file-reference-aliases.ts";
import type { ProviderReplay } from "~/modules/chat/server/provider-replay.ts";
import type { QueuedTurnInput } from "~/modules/chat/queued-turn.ts";
import { desc, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  check,
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
import { projects } from "./projects.ts";

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
    fileReferenceAliases: jsonb("file_reference_aliases").$type<FileReferenceAliases>(),
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
     * are ordinary sidebar chats that also link back to their schedule;
     * deleting the schedule keeps them and clears this. Declared without a
     * reference to avoid a schema import cycle (chat -> schedules -> chat); the
     * FK constraint (`on delete set null`) lives in the migrations.
     */
    scheduleId: text("schedule_id"),
    // Kept out of lists and search, cut off from memory and swept after a day
    // without activity. Cleared by Keep, never set later. See
    // docs/internals/temporary-chats.md.
    temporary: boolean().notNull().default(false),
    // The project whose instructions, documents and memory this chat works
    // with. The chat itself stays its owner's alone; deleting the project
    // turns it back into an ordinary chat.
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    // Put away by its owner: out of the sidebar and every list, still found by
    // search. A message the owner sends clears it; a schedule's does not. See
    // docs/internals/archived-chats.md.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // A scheduled run answered here and its owner has not opened the chat
    // since. Set when the run settles, cleared by opening it.
    unread: boolean().notNull().default(false),
  },
  (t) => [
    check(
      "conversations_project_not_temporary",
      sql`not (${t.temporary} and ${t.projectId} is not null)`,
    ),
    // Nothing lists a temporary chat, so there is nothing to archive it from.
    check(
      "conversations_archived_not_temporary",
      sql`not (${t.temporary} and ${t.archivedAt} is not null)`,
    ),
    index("conversations_project_id_idx").on(t.projectId),
    index("conversations_user_id_idx").on(t.userId),
    // Postgres does not index the referencing side of a foreign key, and
    // `on delete set null` scans it for every deleted conversation.
    index("conversations_branched_from_idx").on(t.branchedFrom),
    index("conversations_last_message_at_idx").on(t.lastMessageAt),
    // Postgres does not index the referencing side of a foreign key, and
    // `on delete set null` from schedules scans it for every deleted schedule.
    index("conversations_schedule_id_idx").on(t.scheduleId),
    // Trigrams, not words: a title substring matches in any script, including
    // ones without spaces, and `ilike '%q%'` can use it.
    index("conversations_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    // Serves the sidebar's keyset paging, which orders by exactly this
    // expression pair (see ChatRepo.listConversations).
    index("conversations_user_activity_idx").on(
      t.userId,
      sql`coalesce(${t.lastMessageAt}, ${t.createdAt}) desc`,
      desc(t.id),
    ),
    // Serves the temporary-chat sweep, which compares exactly this expression.
    index("conversations_temporary_activity_idx")
      .on(sql`coalesce(${t.lastMessageAt}, ${t.createdAt})`)
      .where(sql`${t.temporary}`),
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
    // Set on a user message delivered into a generation that was already
    // running. A steer belongs to that attempt, like its tool rows: it renders
    // inside the answer where it arrived, and goes when the attempt is
    // replaced or the answer deleted.
    steeredIntoMessageId: text("steered_into_message_id").references(
      (): AnyPgColumn => messages.id,
      { onDelete: "cascade" },
    ),
    // Where it arrived: the answer's text length and the model round it
    // followed. Offsets address the raw content, like tool rows'.
    steerTextOffset: integer("steer_text_offset"),
    steerTurnIndex: integer("steer_turn_index"),
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
    // An expression index, not a stored column: every full-row message read
    // would otherwise carry the vector. Queries must repeat this expression
    // exactly (`messageSearchVector` in ChatRepo). See docs/internals/search.md.
    index("messages_search_idx").using(
      "gin",
      sql`to_tsvector('app_search'::regconfig, ${t.content})`,
    ),
    // Serves the total conversation order `(created_at, id)`. Timestamps
    // collide within a turn; uuidv7 ids break the tie in insertion order, and
    // compaction boundaries are positions in exactly this sequence.
    index("messages_conversation_order_idx").on(t.conversationId, t.createdAt, t.id),
    index("messages_steered_into_idx").on(t.steeredIntoMessageId),
    index("messages_streaming_lease_idx")
      .on(t.generationLeaseUntil)
      .where(sql`${t.status} = 'streaming'`),
  ],
);

/**
 * Messages held behind the one live assistant generation. Queue entries are
 * not transcript rows: a branch copies history, never future work. Their files
 * are claimed through `conversation_queue_entry_attachments` and move to the
 * user message the entry becomes; the input holds configuration only.
 */
export const conversationQueueEntries = pgTable(
  "conversation_queue_entries",
  {
    id: text().primaryKey().$defaultFn(uuidv7),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    content: text().notNull(),
    /** Frozen at queue time; attempt resolution still checks live access when promoted. */
    input: jsonb().$type<QueuedTurnInput>().notNull(),
    /** A steer is delivered at a safe model boundary only while this fence is live. */
    steerMessageId: text("steer_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    steerGenerationId: text("steer_generation_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conversation_queue_entries_order_idx").on(t.conversationId, t.id),
    index("conversation_queue_entries_steer_idx")
      .on(t.steerMessageId, t.steerGenerationId)
      .where(sql`${t.steerMessageId} is not null`),
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
    kind: text({ enum: ["text", "reasoning", "tool", "compaction", "file", "steer", "writing"] })
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
 * What a reader set in an answer's ```ui block, so a reload or a branch shows
 * it again. One row per block (its ordinal among the answer's ui fences).
 * `source_hash` is the block's code when saved: a save is accepted only for
 * the stored answer's current block, and a row whose hash no longer matches
 * is ignored (docs/internals/generative-ui.md).
 */
export const messageUiStates = pgTable(
  "message_ui_states",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    sourceHash: text("source_hash").notNull(),
    state: jsonb().$type<JsonValue>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.ordinal] })],
);

/**
 * A failed call's arguments in full, for debugging. The row itself keeps a
 * trimmed copy; this one goes with its call and is swept after a week. Never
 * written for memory saves or typed browser text.
 */
export const toolCallDebugArguments = pgTable("tool_call_debug_arguments", {
  toolCallId: text("tool_call_id")
    .primaryKey()
    .references(() => messageToolCalls.id, { onDelete: "cascade" }),
  arguments: jsonb().$type<JsonValue>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
