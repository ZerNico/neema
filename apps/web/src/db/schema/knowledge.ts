import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { attachmentBlobs } from "./attachments.ts";
import { user } from "./auth.ts";
import { messages } from "./chat.ts";
import { groups } from "./groups.ts";
import { integrationConfigs, integrationConnections } from "./integrations.ts";

// Reusable document collections. A collection is owned by one user and can be
// selected in an ordinary chat or attached to an agent; the two are the same
// resource, so "inline agent knowledge" is just a collection created from the
// agent editor.

/**
 * pgvector column without a declared dimension. Exact (sequential) cosine
 * search is what this release does. An ANN index would need a fixed dimension
 * and would pin every embedding space to the same width forever. Rows are
 * always filtered to one embedding space before a distance is evaluated, so
 * every vector a query compares is the same width.
 */
const embeddingVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

/** Generated `tsvector`; Postgres keeps it in sync with the chunk text. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const knowledgeCollections = pgTable(
  "knowledge_collections",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull().default(""),
    // "private": owner plus explicit grants. "instance": every authenticated
    // user may read/use it (an admin action, not a public link).
    audience: text({ enum: ["private", "instance"] })
      .notNull()
      .default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("knowledge_collections_user_id_idx").on(t.userId)],
);

/**
 * Read/use grants are additive: owner OR direct grant OR a granted group the
 * user is currently in OR instance audience. They never imply edit rights.
 */
export const knowledgeCollectionUserGrants = pgTable(
  "knowledge_collection_user_grants",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.userId] }),
    index("knowledge_collection_user_grants_user_idx").on(t.userId),
  ],
);

export const knowledgeCollectionGroupGrants = pgTable(
  "knowledge_collection_group_grants",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.groupId] }),
    index("knowledge_collection_group_grants_group_idx").on(t.groupId),
  ],
);

/** A choice on one page under a root, overriding what it would inherit. */
export interface KnowledgeSourceRule {
  nodeId: string;
  title: string;
  mode: "include" | "exclude";
}

/**
 * The part of the service a source mirrors: a top-level container or any page
 * in it. `all` takes everything under it, `selected` only what a rule includes;
 * either way the nearest rule on a page or its ancestors wins, so pages added
 * later follow their parent.
 */
export interface KnowledgeSourceRoot {
  nodeId: string;
  title: string;
  mode: "all" | "selected";
  rules: KnowledgeSourceRule[];
}

export interface KnowledgeSourceStats {
  synced: number;
  /** Over the note size limit, so never published. */
  tooLarge: number;
  /** Past the collection's document limit. */
  overLimit: number;
  /** Already mirrored into this collection by another source. */
  elsewhere?: number;
}

/**
 * A subtree of an integration mirrored into a collection. The sync runs as the
 * collection owner's chosen account, so readers of a shared collection see
 * what the owner could see and chose. Disconnecting that account pauses the
 * source until the owner picks one; signing in to it again keeps the same
 * connection. A lost connection keeps the documents already synced.
 */
export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: text().primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    // Restrict: an integration is not deleted while a collection mirrors it.
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrationConfigs.id, { onDelete: "restrict" }),
    // The owner's account the sync runs as; null once it was disconnected.
    connectionId: text("connection_id").references(() => integrationConnections.id, {
      onDelete: "set null",
    }),
    root: jsonb().$type<KnowledgeSourceRoot>().notNull(),
    status: text({ enum: ["idle", "syncing", "error"] })
      .notNull()
      .default("idle"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /**
     * The newest change time the service reported, in its own clock, so the
     * next sync can ask only for what changed since. Null means list in full.
     */
    cursor: timestamp({ withTimezone: true }),
    /** A full listing still runs daily, in case a change slipped past the cursor. */
    fullSyncedAt: timestamp("full_synced_at", { withTimezone: true }),
    /**
     * Pages too large to store, with the change time they had then, so an
     * unchanged one is not downloaded again on every sync.
     */
    oversized: jsonb().$type<Record<string, string>>().notNull().default({}),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }).notNull().defaultNow(),
    stats: jsonb().$type<KnowledgeSourceStats>(),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_sources_collection_idx").on(t.collectionId),
    index("knowledge_sources_due_idx").on(t.nextSyncAt),
    index("knowledge_sources_connection_idx").on(t.connectionId),
  ],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: text().primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    title: text().notNull(),
    kind: text({ enum: ["file", "note"] }).notNull(),
    // The version readers and new generations resolve to. Null while the very
    // first version is still being extracted; a replacement only moves the
    // pointer once the new version is ready, so reads never see a half state.
    currentVersionId: text("current_version_id").references(
      (): AnyPgColumn => knowledgeDocumentVersions.id,
      { onDelete: "set null" },
    ),
    // Set for a document a source mirrors: read-only here, and removed with
    // the source or when the remote document leaves its selection.
    sourceId: text("source_id").references((): AnyPgColumn => knowledgeSources.id, {
      onDelete: "cascade",
    }),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_documents_collection_idx").on(t.collectionId),
    index("knowledge_documents_current_version_idx").on(t.currentVersionId),
    uniqueIndex("knowledge_documents_source_external_idx").on(t.sourceId, t.externalId),
  ],
);

/**
 * One immutable content revision. Text, chunk boundaries and locations never
 * change once published, which is what makes a citation stable and what lets
 * embeddings be rebuilt against the same content. A new upload, an edited note
 * or a parser change all create a new version instead.
 */
export const knowledgeDocumentVersions = pgTable(
  "knowledge_document_versions",
  {
    id: text().primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    title: text().notNull().default(""),
    /**
     * Parser + chunker identity at publication. A version whose fingerprint no
     * longer matches the current pipeline is still perfectly citable; it just
     * predates an improvement, and the owner can rebuild it into a new version.
     */
    pipelineFingerprint: text("pipeline_fingerprint"),
    kind: text({ enum: ["file", "note"] }).notNull(),
    // File versions reference shared bytes; the blob is also protected from
    // the attachment sweep by this reference (see AttachmentRepo).
    // The migration makes this DEFERRABLE INITIALLY DEFERRED (not expressible
    // in Drizzle): account deletion cascades through both resources before the
    // reference check. Direct deletion of a referenced blob still cannot commit.
    blobId: text("blob_id").references(() => attachmentBlobs.id, { onDelete: "no action" }),
    fileName: text("file_name"),
    mediaType: text("media_type"),
    byteSize: integer("byte_size"),
    // Authored note bodies live here; file text is extracted into `text`.
    noteContent: text("note_content"),
    status: text({ enum: ["queued", "extracting", "ready", "failed"] })
      .notNull()
      .default("queued"),
    text: text(),
    pageCount: integer("page_count"),
    charCount: integer("char_count"),
    /** True when extraction hit a page/character limit: never claim full context. */
    truncated: jsonb().$type<{ truncated: boolean; reason: string | null }>(),
    error: text(),
    // Extraction is background work claimed with a lease, so a crashed or
    // reloaded process cannot strand a version in "extracting" forever.
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer().notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("knowledge_document_versions_revision_idx").on(t.documentId, t.revision),
    index("knowledge_document_versions_blob_idx").on(t.blobId),
    // The extraction worker claims by status and expired lease.
    index("knowledge_document_versions_claim_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} in ('queued', 'extracting')`),
  ],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: text().primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => knowledgeDocumentVersions.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    /** Verbatim source text: what a citation points at and a read returns. */
    content: text().notNull(),
    /** Heading breadcrumb ("Vendor Agreement › Termination"), for context. */
    headingPath: text("heading_path").notNull().default(""),
    /** Character range inside the version's text, for section reads. */
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    page: integer(),
    tokens: integer().notNull(),
    // Generated so it cannot drift from the text, and because the chunker has
    // no business knowing the text-search configuration.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        sql`to_tsvector('english', coalesce(${knowledgeChunks.headingPath}, '') || ' ' || ${knowledgeChunks.content})`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("knowledge_chunks_version_ordinal_idx").on(t.versionId, t.ordinal),
    index("knowledge_chunks_search_idx").using("gin", t.searchVector),
  ],
);

/**
 * Current embedding for a chunk. `spaceId` identifies the vector space (model
 * output + dimensions + preprocessing), never the provider or its model name:
 * rotating a key or pointing at the same model on another provider keeps the
 * space, so nothing is re-embedded. A row is replaced in place when the space
 * changes, which is why a rebuild shows partial semantic coverage rather than
 * a second index generation.
 */
export const knowledgeChunkEmbeddings = pgTable(
  "knowledge_chunk_embeddings",
  {
    chunkId: text("chunk_id")
      .primaryKey()
      .references(() => knowledgeChunks.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => knowledgeDocumentVersions.id, { onDelete: "cascade" }),
    spaceId: text("space_id").notNull(),
    dimensions: integer().notNull(),
    embedding: embeddingVector().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("knowledge_chunk_embeddings_version_space_idx").on(t.versionId, t.spaceId)],
);

/**
 * Per-version embedding job. Separate from the immutable version row because
 * the content is final while its derived index is replaceable: switching the
 * embedding space rewrites the target here and re-queues, without touching
 * text, chunk boundaries or citations. Lexical search keeps working throughout.
 */
export const knowledgeEmbeddingJobs = pgTable(
  "knowledge_embedding_jobs",
  {
    versionId: text("version_id")
      .primaryKey()
      .references(() => knowledgeDocumentVersions.id, { onDelete: "cascade" }),
    /** The space this version's vectors should be in. */
    spaceId: text("space_id").notNull(),
    connectionRevision: text("connection_revision"),
    status: text({ enum: ["queued", "running", "ready", "failed"] })
      .notNull()
      .default("queued"),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer().notNull().default(0),
    error: text(),
    /** Not claimed before this, judged by the database clock: a retry's backoff. */
    notBefore: timestamp("not_before", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_embedding_jobs_claim_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

// ------------------------------------------------------------- chat selection

/**
 * The document versions one assistant generation was allowed to see, resolved
 * once at send time inside the turn's transaction. Retry and branch reuse this
 * manifest instead of re-resolving, so a reply never silently answers from
 * content that arrived after the question. `status` records what the manifest
 * captured. A pending or failed document is part of the record, because
 * absence must not read as complete coverage.
 */
export const messageKnowledgeVersions = pgTable(
  "message_knowledge_versions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    versionId: text("version_id"),
    documentId: text("document_id").notNull(),
    // Deletion must leave an unavailable selection, not silently deselect it.
    collectionId: text("collection_id").notNull(),
    status: text({ enum: ["ready", "pending", "failed"] }).notNull(),
    // Display and budgeting metadata as captured: a later rename or re-parse
    // must not change what this generation was told it had.
    title: text().notNull().default(""),
    charCount: integer("char_count"),
    truncated: boolean().notNull().default(false),
    position: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.documentId] }),
    index("message_knowledge_versions_version_idx").on(t.versionId),
  ],
);
