import { sql } from "drizzle-orm";
import {
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
import { attachments } from "./attachments.ts";
import { user } from "./auth.ts";
import { conversations, messages } from "./chat.ts";
import { projects } from "./projects.ts";

/** A ProseMirror document or step as its own `toJSON` writes it. */
type ProseMirrorJson = Record<string, unknown>;

/**
 * One collaboratively edited document, a ProseMirror tree ordered by the
 * server. `snapshot` holds the tree as of `snapshot_revision` and
 * `document_steps` every step after it; `revision` is the number of steps
 * applied, which is the collab version every editor rebases against.
 * Markdown is made from the tree only where it is wanted, never stored.
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
    revision: integer().notNull().default(0),
    lastEditedBy: text("last_edited_by").$type<"user" | "model">().notNull(),
    lastEditorUserId: text("last_editor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    snapshot: jsonb().$type<ProseMirrorJson>().notNull(),
    snapshotRevision: integer("snapshot_revision").notNull().default(0),
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

/**
 * Every step after the snapshot, one row each; `revision` is the version the
 * step produced. Kept long so an editor that was offline can still rebase.
 */
export const documentSteps = pgTable(
  "document_steps",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    step: jsonb().$type<ProseMirrorJson>().notNull(),
    /** The collab client that sent it: an editor's id, or `model`/`server`. */
    clientId: text("client_id").notNull(),
    origin: text().$type<"user" | "model">().notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** The generation that wrote a model step; null for a person. */
    generationId: text("generation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.revision] })],
);

/**
 * Comments on a document's text. A thread is its first comment and the
 * replies naming it; the text it is about carries a `comment` mark with the
 * thread's ID, so the anchor moves with edits and goes with deleted text,
 * leaving the thread without one.
 */
export const documentComments = pgTable(
  "document_comments",
  {
    id: text().primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** The thread's first comment; that comment names itself. */
    threadId: text("thread_id").notNull(),
    /** The person who wrote it; null for the assistant, a file's note, or once the account is gone. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** A person, the assistant, or a note read from an imported file. */
    origin: text().$type<"user" | "model" | "file">().notNull().default("user"),
    /** A file's note only: the author name the file gave, never matched to an account. */
    fileAuthor: text("file_author"),
    body: text().notNull(),
    /** Sent to the assistant as a chat message; answered once it replies after it. */
    toAssistant: boolean("to_assistant").notNull().default(false),
    /** A thread's first comment only: the text it was about, kept once that text is gone. */
    quote: text(),
    /** Set on a thread's first comment only. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_comments_document_idx").on(t.documentId, t.createdAt)],
);

/**
 * An image a person put into a text document: an upload the document claims,
 * served to the document's readers. The claim outlives the image's removal
 * from the text, so undo can bring it back, and goes only with the document;
 * the unclaimed sweep then takes the attachment and its bytes.
 */
export const documentImages = pgTable(
  "document_images",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.attachmentId] }),
    uniqueIndex("document_images_attachment_idx").on(t.attachmentId),
  ],
);
