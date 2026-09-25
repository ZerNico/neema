import { sql } from "drizzle-orm";
import {
  bytea,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { conversations, messages } from "./chat.ts";
import { projects } from "./projects.ts";

/**
 * One collaboratively edited markdown document. The Yjs state is canonical:
 * `snapshot` holds it as of `snapshot_revision` and `document_updates` the
 * batches after it. `content` is the same text as plain markdown, rewritten in
 * the transaction that applies each batch, so the model, cards and search read
 * it without decoding Yjs. `revision` counts applied batches; it tells the
 * model the text moved, and protects nothing.
 *
 * A document belongs to exactly one conversation or one project. A chat's
 * document records the answer that produced it (`created_by_message_id`), and
 * rewinding past that answer removes the document with it, which is why the
 * cascade is here rather than in application code: edit, message delete and
 * conversation delete all go through it. A project's document outlives any
 * answer and is deleted explicitly.
 */
export const documents = pgTable(
  "documents",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    createdByMessageId: text("created_by_message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    title: text().notNull(),
    content: text().notNull(),
    revision: integer().notNull().default(1),
    lastEditedBy: text("last_edited_by").$type<"user" | "model">().notNull(),
    lastEditorUserId: text("last_editor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    snapshot: bytea().notNull(),
    snapshotRevision: integer("snapshot_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("documents_conversation_idx").on(t.conversationId),
    index("documents_project_idx").on(t.projectId),
    check("documents_one_owner", sql`(${t.conversationId} is null) <> (${t.projectId} is null)`),
    check(
      "documents_answer_in_conversation",
      sql`${t.createdByMessageId} is null or ${t.conversationId} is not null`,
    ),
  ],
);

/** Yjs update batches applied after the snapshot, one row per revision. */
export const documentUpdates = pgTable(
  "document_updates",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    update: bytea().notNull(),
    origin: text().$type<"user" | "model">().notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** The generation that wrote a model batch; null for a person. */
    generationId: text("generation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.revision] })],
);
