import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { models } from "./providers.ts";

/**
 * Append-only usage ledger: one row per generation attempt (chat answer,
 * title, context compaction, embedding request, or paid reading of scanned
 * PDF pages), written at finalize time and never updated.
 * Retry adds a new row, branching copies nothing, deleting a conversation
 * leaves it intact. That is exactly why analytics reads this and not
 * `messages.usage`.
 */

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text({
      enum: ["chat", "title", "compaction", "embedding_document", "embedding_query", "ocr"],
    }).notNull(),
    modelId: text("model_id").references(() => models.id, { onDelete: "set null" }),
    // displayName snapshot so a deleted model still labels its history
    modelName: text("model_name").notNull(),
    // Plain text on purpose: an FK would cascade the ledger away with the
    // conversation. These only serve drill-down/debugging.
    conversationId: text("conversation_id"),
    messageId: text("message_id"),
    status: text({ enum: ["complete", "error", "aborted"] }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    // Tokens written to a provider's prompt cache, billed above the input
    // price by some. Null where the provider did not say.
    cacheWriteTokens: integer("cache_write_tokens"),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    // USD. Null = unknown (no provider-reported cost and no model pricing).
    usageComplete: boolean("usage_complete").notNull().default(true),
    cost: doublePrecision(),
    costSource: text("cost_source", { enum: ["provider", "pricing"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_user_created_idx").on(t.userId, t.createdAt),
    index("usage_events_created_idx").on(t.createdAt),
    index("usage_events_model_idx").on(t.modelId),
  ],
);
