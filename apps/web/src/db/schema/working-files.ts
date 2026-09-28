import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { attachments } from "./attachments.ts";
import { conversations, messages } from "./chat.ts";

/**
 * An unpublished working file (a deck being edited, a custom tool's draft) as
 * one answer left it, so a later answer in the chat can continue it. A file
 * has one row per answer that changed or published it, holding only that
 * answer's latest revision; the newest answer's row is the file's state.
 * Retrying or rewinding an answer removes its rows, which restores the state
 * the answer started from.
 *
 * The bytes are an attachment the row claims, owned through the answer like
 * its message attachments. See docs/internals/files.md.
 */
export const conversationWorkingFiles = pgTable(
  "conversation_working_files",
  {
    // The working-file id the model's `working:<id>@<revision>` refers to.
    workingFileId: text("working_file_id").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // Null once this answer published the file: nothing is kept from here on.
    attachmentId: text("attachment_id").references(() => attachments.id, { onDelete: "cascade" }),
    name: text().notNull(),
    mediaType: text("media_type").notNull(),
    owner: text({ enum: ["presentation", "custom"] }).notNull(),
    // The one module that may revise a custom draft.
    customToolId: text("custom_tool_id"),
    revision: integer().notNull(),
    fingerprint: text().notNull(),
    // The pinned source a draft was opened from, checked again before use.
    source: text(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workingFileId, t.messageId] }),
    index("conversation_working_files_conversation_idx").on(t.conversationId),
    index("conversation_working_files_message_idx").on(t.messageId),
    uniqueIndex("conversation_working_files_attachment_idx").on(t.attachmentId),
    index("conversation_working_files_updated_idx").on(t.updatedAt),
  ],
);
