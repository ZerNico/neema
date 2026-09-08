import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { messages } from "./chat.ts";

// Stored bytes, content-addressed. Dedup is scoped to one user: a global
// (sha256) unique would let anyone probe whether some other user already
// uploaded a given file.
export const attachmentBlobs = pgTable(
  "attachment_blobs",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // hex digest computed server-side over the received bytes; client hashes
    // are never trusted (they would be a free "does this exist" oracle)
    sha256: text().notNull(),
    // opaque key in the BlobStore (filesystem today, S3 later)
    storageKey: text("storage_key").notNull(),
    size: integer().notNull(),
    // normalized from the magic bytes, not from the upload's Content-Type
    mediaType: text("media_type").notNull(),
    // Lazy cache of locally extracted PDF text, so a long conversation does not
    // re-parse the same document on every generation. `parsedWith` records the
    // parser kind: a different configured backend invalidates the cache.
    parsedText: text("parsed_text"),
    parsedWith: text("parsed_with"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("attachment_blobs_user_sha256_idx").on(t.userId, t.sha256),
    uniqueIndex("attachment_blobs_storage_key_idx").on(t.storageKey),
  ],
);

/**
 * Durable intent to remove bytes from the blob store.
 *
 * Physical objects and database rows cannot be changed atomically, so both
 * directions of the gap are recorded here before the risky half runs:
 *
 * - `candidate` is written before an upload's bytes are stored, and covers the
 *   window where the object exists but its row does not yet — a cancelled
 *   request or a lost commit acknowledgement would otherwise strand bytes no
 *   row-following sweep can ever find.
 * - `orphan` is written inside the transaction that removes a blob's last
 *   reference, so a crash between that commit and the delete cannot lose the key.
 *
 * The reconciler resolves a `candidate` by asking whether any blob row now owns
 * the key: registration may have committed even when the caller saw a failure,
 * so ownership — never the caller's error — decides.
 */
export const blobCleanupIntents = pgTable(
  "blob_cleanup_intents",
  {
    // The key itself is the identity: one pending decision per stored object.
    storageKey: text("storage_key").primaryKey(),
    kind: text({ enum: ["candidate", "orphan"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Retries back off; a store that keeps failing must not spin.
    attempts: integer().notNull().default(0),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("blob_cleanup_intents_due_idx").on(t.notBefore)],
);

// One row per chip the user added — the same bytes attached twice give two
// attachments sharing one blob, each with its own name.
export const attachments = pgTable(
  "attachments",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    blobId: text("blob_id")
      .notNull()
      .references(() => attachmentBlobs.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("attachments_user_id_idx").on(t.userId),
    index("attachments_blob_id_idx").on(t.blobId),
    // the orphan sweep scans by age for rows that were never claimed
    index("attachments_created_at_idx").on(t.createdAt),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
    position: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.attachmentId] }),
    // An attachment belongs to exactly one message: this is the claim, and it
    // is what makes two concurrent sends racing for the same upload safe.
    uniqueIndex("message_attachments_attachment_id_idx").on(t.attachmentId),
    uniqueIndex("message_attachments_message_position_idx").on(t.messageId, t.position),
  ],
);
