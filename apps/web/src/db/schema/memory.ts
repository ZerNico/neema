import { desc, sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { conversations, messages } from "./chat.ts";

export const memorySettings = pgTable("memory_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  referenceEnabled: boolean("reference_enabled").notNull().default(true),
  autoSaveEnabled: boolean("auto_save_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memories = pgTable(
  "memories",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    content: text().notNull(),
    // SHA-256 of normalized content. The unique index makes dedupe authoritative;
    // application-level advisory locking makes the accompanying row cap atomic.
    contentHash: text("content_hash").notNull(),
    origin: text({ enum: ["manual", "model"] }).notNull(),
    // Any user edit sets this, including edits to model-created rows. Automatic
    // updates are only allowed while a model row remains unedited.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    sourceConversationId: text("source_conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    sourceMessageId: text("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    // Hash of the exact source-message content at save time. A later mismatch
    // is provenance metadata for the settings UI; it never suppresses the memory.
    sourceMessageHash: text("source_message_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memories_user_content_hash_idx").on(t.userId, t.contentHash),
    // User-managed rows (manual or edited) are listed before untouched model
    // rows, then newest-first with id as the stable final tie-breaker.
    index("memories_user_managed_order_idx").on(
      t.userId,
      sql`(case when ${t.origin} = 'manual' or ${t.editedAt} is not null then 0 else 1 end)`,
      desc(t.updatedAt),
      desc(t.id),
    ),
    index("memories_source_conversation_id_idx").on(t.sourceConversationId),
    index("memories_source_message_id_idx").on(t.sourceMessageId),
  ],
);
