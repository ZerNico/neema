import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { conversations, messages } from "./chat.ts";

/**
 * One editable draft per thing being authored from a chat (an agent, a
 * schedule). `settings` is the per-kind working payload; the owning module's
 * service decodes it, the repo stores it opaque.
 *
 * The target is an identity snapshot, not a foreign key: deleting the agent or
 * schedule must never turn the next save into creation, or erase an accepted
 * save receipt.
 *
 * `created_by_message_id` is the answer whose tool call opened it. Rewinding
 * past that answer removes the draft with it, as for conversation documents: a
 * draft no remaining message introduced would dangle in the chat and in the
 * model's context.
 */
export const conversationDrafts = pgTable(
  "conversation_drafts",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdByMessageId: text("created_by_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    kind: text({ enum: ["agent", "schedule"] }).notNull(),
    settings: jsonb().notNull(),
    revision: integer().notNull().default(1),
    targetId: text("target_id"),
    targetRevision: integer("target_revision"),
    savedDraftRevision: integer("saved_draft_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conversation_drafts_conversation_idx").on(t.conversationId),
    index("conversation_drafts_kind_idx").on(t.kind),
    index("conversation_drafts_created_by_message_idx").on(t.createdByMessageId),
  ],
);
