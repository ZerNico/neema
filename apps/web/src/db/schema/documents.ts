import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { conversations, messages } from "./chat.ts";

/**
 * One editable markdown artifact per row, overwritten in place. `revision` is
 * a compare-and-swap token, not history: a branch keeps only a reference.
 *
 * `created_by_message_id` is the answer that produced it. Rewinding past that
 * answer removes the document with it, which is why the cascade is here rather
 * than in application code: edit, message delete and conversation delete all
 * go through it. Null only for rows written before the column existed.
 */
export const conversationDocuments = pgTable(
  "conversation_documents",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdByMessageId: text("created_by_message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    title: text().notNull(),
    content: text().notNull(),
    revision: integer().notNull().default(1),
    lastEditedBy: text("last_edited_by").$type<"user" | "model">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversation_documents_conversation_idx").on(t.conversationId)],
);
