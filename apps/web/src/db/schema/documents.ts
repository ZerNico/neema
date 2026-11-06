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
import { groups } from "./groups.ts";
import { PROJECT_MEMBER_ROLES, projects } from "./projects.ts";

/** A ProseMirror document or step as its own `toJSON` writes it. */
type ProseMirrorJson = Record<string, unknown>;

/**
 * One collaboratively edited document, a ProseMirror tree ordered by the
 * server. `snapshot` holds the tree as of `snapshot_revision` and
 * `document_steps` every step after it; `revision` is the number of steps
 * applied, which is the collab version every editor rebases against.
 * Markdown is made from the tree only where it is wanted, never stored.
 *
 * A document belongs to one person or one project; chats only show it,
 * through `conversation_documents`. It outlives the answer and the chat that
 * made it and is deleted explicitly, except one made in a temporary chat and
 * used nowhere else, which that chat's purge takes.
 */
export const documents = pgTable(
  "documents",
  {
    id: text().primaryKey(),
    /** A personal document's owner; null for a project's. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The chat that made it, set once at creation; null for one started
     * elsewhere or once that chat is gone. Never derived from links: naming a
     * document in a chat must not make it that chat's.
     */
    originConversationId: text("origin_conversation_id").references(() => conversations.id, {
      onDelete: "set null",
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
    index("documents_user_idx").on(t.userId),
    index("documents_project_idx").on(t.projectId),
    index("documents_origin_idx")
      .on(t.originConversationId)
      .where(sql`${t.originConversationId} is not null`),
    check("documents_one_owner", sql`(${t.userId} is null) <> (${t.projectId} is null)`),
  ],
);

/**
 * The chats that show a document. A link grants nothing: the reader still
 * needs access to the document itself. `message_id` is the answer whose card
 * shows it.
 */
export const conversationDocuments = pgTable(
  "conversation_documents",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.documentId] }),
    index("conversation_documents_document_idx").on(t.documentId),
    index("conversation_documents_message_idx")
      .on(t.messageId)
      .where(sql`${t.messageId} is not null`),
  ],
);

/**
 * A person's document shared with another account, as viewer or editor.
 * Project documents are shared by their project instead.
 */
export const documentUserGrants = pgTable(
  "document_user_grants",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text({ enum: PROJECT_MEMBER_ROLES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.userId] }),
    index("document_user_grants_user_idx").on(t.userId),
  ],
);

/** A person's document shared with every member of a group. */
export const documentGroupGrants = pgTable(
  "document_group_grants",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    role: text({ enum: PROJECT_MEMBER_ROLES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.groupId] }),
    index("document_group_grants_group_idx").on(t.groupId),
  ],
);

/**
 * A person's document readable by anyone holding the token, without signing
 * in. One per document; turning it off deletes the row, so a new link is a
 * new token. It reads only while the owner may still publish.
 */
export const documentPublicLinks = pgTable("document_public_links", {
  documentId: text("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  token: text().notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
 * The text at the end of a version whose steps were folded into the
 * snapshot, so history reaches past the steps kept for rebasing. Older ones
 * are thinned to one a day, then one a week; a named one is kept.
 */
export const documentVersions = pgTable(
  "document_versions",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    snapshot: jsonb().$type<ProseMirrorJson>().notNull(),
    /** Who wrote the version; null for the document's start, which nobody's steps made. */
    origin: text().$type<"user" | "model">(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** When its last step came. */
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    name: text(),
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
