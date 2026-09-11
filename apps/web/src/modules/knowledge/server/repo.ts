import { and, asc, count, desc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  attachmentBlobs,
  knowledgeChunkEmbeddings,
  knowledgeChunks,
  knowledgeCollections,
  knowledgeDocumentVersions,
  knowledgeDocuments,
  knowledgeEmbeddingJobs,
  user,
} from "~/db/schema/index.ts";
import { collectOrphanedBlobs, lockBlobs } from "~/modules/attachments/server/blob-references.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";
import type { CollectionSummary, KnowledgeDocument, KnowledgePassage } from "../schema.ts";
import { KNOWLEDGE_LIMITS } from "../schema.ts";
import { KnowledgeNotAvailable, KnowledgeRejected } from "../errors.ts";
import { collectionReadable } from "./access.ts";
import { pipelineFingerprint, type DocumentChunk } from "./chunking.ts";
import { readEmbeddingTarget, type EmbeddingTarget } from "./embedding-connection.ts";

type VersionRow = typeof knowledgeDocumentVersions.$inferSelect;

export interface VersionBodyReference {
  collectionId: string;
  documentId: string;
  versionId: string;
  charCount: number;
}
export interface VersionBody extends VersionBodyReference {
  title: string;
  text: string;
}

/** How long a claimed extraction/embedding job is protected from re-claiming. */
const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 3;

const semanticStatus = (
  status: string | null,
  jobSpaceId: string | null,
  jobConnectionRevision: string | null,
  target: Pick<EmbeddingTarget, "spaceId" | "connectionRevision"> | null,
): KnowledgeDocument["semanticStatus"] => {
  if (!target) return "disabled";
  // A job still pointing at the previous space is not "ready" for this one:
  // its vectors are excluded from search until it is rebuilt.
  if (!status || jobSpaceId !== target.spaceId) return "needs_reindex";
  if (status !== "ready" && jobConnectionRevision !== target.connectionRevision)
    return "needs_reindex";
  return status === "ready"
    ? "ready"
    : status === "failed"
      ? "failed"
      : status === "running"
        ? "running"
        : "queued";
};

const toDocument = (
  row: typeof knowledgeDocuments.$inferSelect & {
    version: Pick<
      VersionRow,
      | "id"
      | "revision"
      | "status"
      | "fileName"
      | "mediaType"
      | "byteSize"
      | "charCount"
      | "pageCount"
      | "truncated"
      | "error"
    > | null;
    latest: Pick<VersionRow, "id" | "revision" | "title" | "status" | "error"> | null;
    jobStatus: string | null;
    jobSpaceId: string | null;
    jobConnectionRevision: string | null;
  },
  target: Pick<EmbeddingTarget, "spaceId" | "connectionRevision"> | null,
): KnowledgeDocument => ({
  id: row.id,
  collectionId: row.collectionId,
  title: row.title,
  kind: row.kind,
  status: row.version?.status ?? "queued",
  semanticStatus:
    row.version?.status === "ready"
      ? semanticStatus(row.jobStatus, row.jobSpaceId, row.jobConnectionRevision, target)
      : "queued",
  fileName: row.version?.fileName ?? null,
  mediaType: row.version?.mediaType ?? null,
  byteSize: row.version?.byteSize ?? null,
  charCount: row.version?.charCount ?? null,
  pageCount: row.version?.pageCount ?? null,
  truncated: row.version?.truncated?.truncated ?? false,
  error: row.version?.error ?? null,
  versionId: row.version?.id ?? null,
  replacement:
    row.latest &&
    row.latest.id !== row.version?.id &&
    row.latest.revision > (row.version?.revision ?? 0)
      ? {
          versionId: row.latest.id,
          title: row.latest.title,
          status: row.latest.status,
          error: row.latest.error,
        }
      : null,
  updatedAt: row.updatedAt.toISOString(),
});

const latestVersion = alias(knowledgeDocumentVersions, "latest_version");
const latestVersionId = sql`(select v.id from knowledge_document_versions v where v.document_id = ${knowledgeDocuments.id} order by v.revision desc limit 1)`;
const displayedVersionId = sql`coalesce(${knowledgeDocuments.currentVersionId}, ${latestVersionId})`;

const ownedCollection = (userId: string, collectionId: string) =>
  and(eq(knowledgeCollections.id, collectionId), eq(knowledgeCollections.userId, userId));

const readableCollection = (userId: string, collectionId: string) =>
  and(eq(knowledgeCollections.id, collectionId), collectionReadable(userId));

const summarize = (
  row: typeof knowledgeCollections.$inferSelect & { ownerName: string | null },
  counts: { total: number; ready: number; failed: number },
  userId: string,
): CollectionSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  audience: row.audience,
  canEdit: row.userId === userId,
  ownerName: row.userId === userId ? null : row.ownerName,
  documentCount: counts.total,
  readyCount: counts.ready,
  failedCount: counts.failed,
  pendingCount: Math.max(0, counts.total - counts.ready - counts.failed),
  updatedAt: row.updatedAt.toISOString(),
});

export interface ManifestEntry {
  readonly collectionId: string;
  readonly documentId: string;
  readonly versionId: string | null;
  readonly title: string;
  readonly status: "ready" | "pending" | "failed";
  readonly charCount: number | null;
  readonly truncated: boolean;
}

export class KnowledgeRepo extends Context.Service<
  KnowledgeRepo,
  {
    listCollections(userId: string): Effect.Effect<ReadonlyArray<CollectionSummary>>;
    /** Null when the collection does not exist *or* is not readable. */
    getCollection(userId: string, collectionId: string): Effect.Effect<CollectionSummary | null>;
    createCollection(
      userId: string,
      input: { name: string; description: string },
    ): Effect.Effect<string, KnowledgeRejected>;
    updateCollection(
      userId: string,
      collectionId: string,
      patch: { name?: string; description?: string },
    ): Effect.Effect<boolean>;
    /** Owner-only. Returns storage keys whose last reference just went away. */
    deleteCollection(userId: string, collectionId: string): Effect.Effect<ReadonlyArray<string>>;

    listDocuments(
      userId: string,
      collectionId: string,
      target: Pick<EmbeddingTarget, "spaceId" | "connectionRevision"> | null,
    ): Effect.Effect<ReadonlyArray<KnowledgeDocument>>;
    /** Adds a file document referencing already-stored bytes. */
    addFileDocument(
      userId: string,
      input: {
        collectionId: string;
        blobId: string;
        title: string;
        fileName: string;
        mediaType: string;
        byteSize: number;
      },
    ): Effect.Effect<{ documentId: string; versionId: string } | null>;
    addNoteDocument(
      userId: string,
      input: { collectionId: string; title: string; content: string },
    ): Effect.Effect<{ documentId: string; versionId: string } | null>;
    replaceFileDocument(
      userId: string,
      input: {
        collectionId: string;
        documentId: string;
        blobId: string;
        title: string;
        fileName: string;
        mediaType: string;
        byteSize: number;
      },
    ): Effect.Effect<{ documentId: string; versionId: string } | null>;
    replaceNoteDocument(
      userId: string,
      input: { collectionId: string; documentId: string; title: string; content: string },
    ): Effect.Effect<{ documentId: string; versionId: string } | null>;
    retryDocument(userId: string, documentId: string): Effect.Effect<boolean>;
    deleteDocument(userId: string, documentId: string): Effect.Effect<ReadonlyArray<string>>;

    /** Terminalize exhausted leases even when embeddings are disabled. Returns changed rows. */
    recoverExpiredJobs(): Effect.Effect<number>;
    /** Claims one version awaiting extraction; null when there is nothing to do. */
    claimExtraction(): Effect.Effect<{
      version: VersionRow;
      /** Where the bytes live, for file versions. */
      storageKey: string | null;
      leaseToken: string;
    } | null>;
    completeExtraction(input: {
      versionId: string;
      leaseToken: string;
      text: string;
      pageCount: number | null;
      truncated: { truncated: boolean; reason: string | null };
      chunks: ReadonlyArray<DocumentChunk>;
      parsedWith?: string | null;
    }): Effect.Effect<boolean>;
    failExtraction(input: {
      versionId: string;
      leaseToken: string;
      error: string;
      retryable: boolean;
    }): Effect.Effect<void>;

    claimEmbedding(
      spaceId: string,
      connectionRevision: string,
    ): Effect.Effect<{ versionId: string; leaseToken: string; ownerUserId: string } | null>;
    renewEmbedding(
      versionId: string,
      leaseToken: string,
      connectionRevision: string,
    ): Effect.Effect<boolean>;
    listChunksForEmbedding(
      versionId: string,
    ): Effect.Effect<
      ReadonlyArray<{ id: string; content: string; headingPath: string; title: string }>
    >;
    completeEmbedding(input: {
      versionId: string;
      leaseToken: string;
      spaceId: string;
      connectionRevision: string;
      dimensions: number;
      vectors: ReadonlyArray<{ chunkId: string; embedding: ReadonlyArray<number> }>;
    }): Effect.Effect<boolean>;
    failEmbedding(input: {
      versionId: string;
      leaseToken: string;
      error: string;
      retryable: boolean;
    }): Effect.Effect<void>;
    /**
     * Every collection id on the instance, for an admin-triggered rebuild.
     * The rebuild itself is still the owner-scoped path, run per collection,
     * so no per-user rule is bypassed — the admin only starts it.
     */
    listAllCollectionIds(): Effect.Effect<ReadonlyArray<{ id: string; userId: string }>>;
    /** Role check for admin-only knowledge operations; same source as the sharing rules. */
    isAdmin(userId: string): Effect.Effect<boolean>;
    /**
     * Queues embedding jobs for the collection's published versions. `staleOnly`
     * skips versions already ready in the current space on the current
     * connection, so a repeated rebuild does not re-embed a healthy corpus.
     */
    reindexCollection(
      userId: string,
      collectionId: string,
      options?: { staleOnly?: boolean },
    ): Effect.Effect<number>;
    /**
     * Queues a fresh version for every ready document whose published content
     * was produced by an older parser/chunker. The old version is retained, so
     * citations into it keep resolving until the document is deleted; the new
     * one becomes current only when it is ready.
     */
    rebuildCollectionContent(
      userId: string,
      collectionId: string,
      /** Every fingerprint the current pipeline can still produce, across kinds. */
      currentFingerprints: ReadonlyArray<string>,
      pdfAvailable?: boolean,
    ): Effect.Effect<number>;

    /**
     * Resolves the document versions a generation may see. Callers pass only
     * collection ids the user was authorized for; the query re-checks anyway.
     */
    resolveManifest(
      userId: string,
      collectionIds: ReadonlyArray<string>,
      tx?: DbTx,
    ): Effect.Effect<ReadonlyArray<ManifestEntry>, KnowledgeNotAvailable>;
    /** Fresh all-or-nothing access to saved versions, including retained replacements. */
    authorizeVersions(
      userId: string,
      versionIds: ReadonlyArray<string>,
    ): Effect.Effect<void, KnowledgeNotAvailable>;
    /** Recheck saved identities without resolving newer published content. */
    authorizeManifest(
      userId: string,
      collectionIds: ReadonlyArray<string>,
      manifest: ReadonlyArray<ManifestEntry>,
      tx?: DbTx,
    ): Effect.Effect<void, KnowledgeNotAvailable>;
    /** Lexical candidates within an explicit, already-authorized version set. */
    searchLexical(
      versionIds: ReadonlyArray<string>,
      query: string,
      limit: number,
    ): Effect.Effect<ReadonlyArray<{ chunkId: string; rank: number }>>;
    semanticVersionCount(versionIds: ReadonlyArray<string>, spaceId: string): Effect.Effect<number>;
    /** Vector candidates in one embedding space. */
    searchSemantic(input: {
      versionIds: ReadonlyArray<string>;
      spaceId: string;
      embedding: ReadonlyArray<number>;
      limit: number;
    }): Effect.Effect<ReadonlyArray<{ chunkId: string; rank: number }>>;
    loadPassages(chunkIds: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<KnowledgePassage>>;
    /** Bounded original-text transfer at UTF-16 offsets. The caller must authorize access. */
    readVersionRange(
      versionId: string,
      startOffset: number,
      endOffset: number,
    ): Effect.Effect<string | null>;
    /** Full bodies only after context metadata admission, in bounded SQL batches. */
    readVersionBodiesForAccess(
      userId: string,
      references: ReadonlyArray<VersionBodyReference>,
    ): Effect.Effect<ReadonlyArray<VersionBody>>;
    documentCollection(
      userId: string,
      documentId: string,
    ): Effect.Effect<{ collectionId: string; canEdit: boolean } | null>;
    readVersionForAccess(
      userId: string,
      reference: { collectionId: string; documentId: string; versionId: string },
    ): Effect.Effect<{
      title: string;
      status: VersionRow["status"];
      charCount: number | null;
      fileName: string | null;
      mediaType: string | null;
      storageKey: string | null;
    } | null>;
  }
>()("chat/knowledge/KnowledgeRepo") {
  static readonly layer = Layer.effect(
    KnowledgeRepo,
    Effect.gen(function* () {
      const db = yield* Db;

      // Counts drive the collection list's "3 indexing, 1 failed" line.
      const documentCounts = (collectionId: string) =>
        db
          .select({
            total: count(),
            ready: sql<number>`count(*) filter (where ${knowledgeDocumentVersions.status} = 'ready')`,
            failed: sql<number>`count(*) filter (where ${knowledgeDocumentVersions.status} = 'failed')`,
          })
          .from(knowledgeDocuments)
          .leftJoin(knowledgeDocumentVersions, eq(knowledgeDocumentVersions.id, displayedVersionId))
          .where(eq(knowledgeDocuments.collectionId, collectionId))
          .pipe(Effect.orDie);

      const listCollections = Effect.fn("KnowledgeRepo.listCollections")(function* (
        userId: string,
      ) {
        const rows = yield* db
          .select({
            collection: knowledgeCollections,
            ownerName: user.name,
            total: sql<number>`(
              select count(*) from ${knowledgeDocuments}
              where ${knowledgeDocuments.collectionId} = ${knowledgeCollections.id}
            )`,
            ready: sql<number>`(
              select count(*) from ${knowledgeDocuments} d
              join ${knowledgeDocumentVersions} v on v.id = d.current_version_id
              where d.collection_id = ${knowledgeCollections.id} and v.status = 'ready'
            )`,
            failed: sql<number>`(
              select count(*) from ${knowledgeDocuments} d
              join ${knowledgeDocumentVersions} v on v.id = d.current_version_id
              where d.collection_id = ${knowledgeCollections.id} and v.status = 'failed'
            )`,
          })
          .from(knowledgeCollections)
          .innerJoin(user, eq(user.id, knowledgeCollections.userId))
          .where(collectionReadable(userId))
          .orderBy(asc(knowledgeCollections.name))
          .pipe(Effect.orDie);
        return rows.map((row) =>
          summarize(
            { ...row.collection, ownerName: row.ownerName },
            { total: Number(row.total), ready: Number(row.ready), failed: Number(row.failed) },
            userId,
          ),
        );
      });

      const getCollection = Effect.fn("KnowledgeRepo.getCollection")(function* (
        userId: string,
        collectionId: string,
      ) {
        const rows = yield* db
          .select({ collection: knowledgeCollections, ownerName: user.name })
          .from(knowledgeCollections)
          .innerJoin(user, eq(user.id, knowledgeCollections.userId))
          .where(readableCollection(userId, collectionId))
          .limit(1)
          .pipe(Effect.orDie);
        const row = rows[0];
        if (!row) return null;
        const counts = (yield* documentCounts(collectionId))[0] ?? {
          total: 0,
          ready: 0,
          failed: 0,
        };
        return summarize(
          { ...row.collection, ownerName: row.ownerName },
          {
            total: Number(counts.total),
            ready: Number(counts.ready),
            failed: Number(counts.failed),
          },
          userId,
        );
      });

      const createCollection = Effect.fn("KnowledgeRepo.createCollection")(function* (
        userId: string,
        input: { name: string; description: string },
      ) {
        const id = uuidv7();
        const created = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Serialize the per-owner count with concurrent creates.
              const [owner] = yield* tx
                .select({ id: user.id })
                .from(user)
                .where(eq(user.id, userId))
                .for("update");
              if (!owner) return false;
              const [existing] = yield* tx
                .select({ total: count() })
                .from(knowledgeCollections)
                .where(eq(knowledgeCollections.userId, userId));
              if (Number(existing?.total ?? 0) >= KNOWLEDGE_LIMITS.maxCollectionsPerUser)
                return false;
              yield* tx
                .insert(knowledgeCollections)
                .values({ id, userId, name: input.name, description: input.description });
              return true;
            }),
          )
          .pipe(Effect.orDie);
        if (!created) return yield* new KnowledgeRejected({ reason: "collection limit reached" });
        return id;
      });

      const updateCollection = Effect.fn("KnowledgeRepo.updateCollection")(function* (
        userId: string,
        collectionId: string,
        patch: { name?: string; description?: string },
      ) {
        const rows = yield* db
          .update(knowledgeCollections)
          .set({ ...patch, updatedAt: new Date() })
          .where(ownedCollection(userId, collectionId))
          .returning({ id: knowledgeCollections.id })
          .pipe(Effect.orDie);
        return rows.length > 0;
      });

      const deleteCollection = Effect.fn("KnowledgeRepo.deleteCollection")(function* (
        userId: string,
        collectionId: string,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const owned = yield* tx
                .select({ id: knowledgeCollections.id })
                .from(knowledgeCollections)
                .where(ownedCollection(userId, collectionId))
                .limit(1)
                .for("update");
              if (owned.length === 0) return [] as string[];

              // Blob ids first: the version rows are about to cascade away.
              const blobs = yield* tx
                .select({ blobId: knowledgeDocumentVersions.blobId })
                .from(knowledgeDocumentVersions)
                .innerJoin(
                  knowledgeDocuments,
                  eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
                )
                .where(eq(knowledgeDocuments.collectionId, collectionId));
              const blobIds = [
                ...new Set(blobs.flatMap((row) => (row.blobId ? [row.blobId] : []))),
              ];
              yield* lockBlobs(tx, blobIds);
              // Break the document → current version cycle before deleting.
              yield* tx
                .update(knowledgeDocuments)
                .set({ currentVersionId: null })
                .where(eq(knowledgeDocuments.collectionId, collectionId));
              yield* tx
                .delete(knowledgeCollections)
                .where(eq(knowledgeCollections.id, collectionId));
              return yield* collectOrphanedBlobs(tx, blobIds);
            }),
          )
          .pipe(Effect.orDie);
      });

      const listDocuments = Effect.fn("KnowledgeRepo.listDocuments")(function* (
        userId: string,
        collectionId: string,
        target: Pick<EmbeddingTarget, "spaceId" | "connectionRevision"> | null,
      ) {
        const readable = yield* db
          .select({ id: knowledgeCollections.id })
          .from(knowledgeCollections)
          .where(readableCollection(userId, collectionId))
          .limit(1)
          .pipe(Effect.orDie);
        if (readable.length === 0) return [];

        const rows = yield* db
          .select({
            document: knowledgeDocuments,
            version: {
              id: knowledgeDocumentVersions.id,
              revision: knowledgeDocumentVersions.revision,
              status: knowledgeDocumentVersions.status,
              fileName: knowledgeDocumentVersions.fileName,
              mediaType: knowledgeDocumentVersions.mediaType,
              byteSize: knowledgeDocumentVersions.byteSize,
              charCount: knowledgeDocumentVersions.charCount,
              pageCount: knowledgeDocumentVersions.pageCount,
              truncated: knowledgeDocumentVersions.truncated,
              error: knowledgeDocumentVersions.error,
            },
            latest: {
              id: latestVersion.id,
              revision: latestVersion.revision,
              title: latestVersion.title,
              status: latestVersion.status,
              error: latestVersion.error,
            },
            jobStatus: knowledgeEmbeddingJobs.status,
            jobSpaceId: knowledgeEmbeddingJobs.spaceId,
            jobConnectionRevision: knowledgeEmbeddingJobs.connectionRevision,
          })
          .from(knowledgeDocuments)
          .innerJoin(
            knowledgeCollections,
            eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
          )
          .leftJoin(knowledgeDocumentVersions, eq(knowledgeDocumentVersions.id, displayedVersionId))
          .leftJoin(latestVersion, eq(latestVersion.id, latestVersionId))
          .leftJoin(
            knowledgeEmbeddingJobs,
            eq(knowledgeEmbeddingJobs.versionId, knowledgeDocumentVersions.id),
          )
          .where(and(eq(knowledgeDocuments.collectionId, collectionId), collectionReadable(userId)))
          .orderBy(asc(knowledgeDocuments.title), asc(knowledgeDocuments.id))
          .pipe(Effect.orDie);

        return rows.map((row) =>
          toDocument(
            {
              ...row.document,
              version: row.version,
              latest: row.latest,
              jobStatus: row.jobStatus,
              jobSpaceId: row.jobSpaceId,
              jobConnectionRevision: row.jobConnectionRevision,
            },
            target,
          ),
        );
      });

      const insertDocument = (
        userId: string,
        input: {
          collectionId: string;
          documentId?: string;
          title: string;
          kind: "file" | "note";
          version: {
            blobId?: string;
            fileName?: string;
            mediaType?: string;
            byteSize?: number;
            noteContent?: string;
          };
        },
      ) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const target = yield* readEmbeddingTarget(tx, true);
              const owned = yield* tx
                .select({ id: knowledgeCollections.id })
                .from(knowledgeCollections)
                .where(ownedCollection(userId, input.collectionId))
                .limit(1)
                .for("update");
              if (owned.length === 0) return null;

              let documentId: string;
              if (input.documentId) {
                const [existing] = yield* tx
                  .select({ id: knowledgeDocuments.id })
                  .from(knowledgeDocuments)
                  .where(
                    and(
                      eq(knowledgeDocuments.id, input.documentId),
                      eq(knowledgeDocuments.collectionId, input.collectionId),
                    ),
                  )
                  .for("update");
                if (!existing) return null;
                documentId = existing.id;
              } else {
                const [existing] = yield* tx
                  .select({ total: count() })
                  .from(knowledgeDocuments)
                  .where(eq(knowledgeDocuments.collectionId, input.collectionId));
                if (Number(existing?.total ?? 0) >= KNOWLEDGE_LIMITS.maxDocumentsPerCollection)
                  return null;
                documentId = uuidv7();
              }
              let content = input.version;
              if (content.blobId) {
                const [blob] = yield* lockBlobs(tx, [content.blobId]);
                if (!blob || blob.userId !== userId) return null;
                content = { ...content, mediaType: blob.mediaType, byteSize: blob.size };
              }
              const [latest] = input.documentId
                ? yield* tx
                    .select({
                      id: knowledgeDocumentVersions.id,
                      revision: knowledgeDocumentVersions.revision,
                      title: knowledgeDocumentVersions.title,
                      kind: knowledgeDocumentVersions.kind,
                      blobId: knowledgeDocumentVersions.blobId,
                      fileName: knowledgeDocumentVersions.fileName,
                      mediaType: knowledgeDocumentVersions.mediaType,
                      byteSize: knowledgeDocumentVersions.byteSize,
                      noteContent: knowledgeDocumentVersions.noteContent,
                    })
                    .from(knowledgeDocumentVersions)
                    .where(eq(knowledgeDocumentVersions.documentId, documentId))
                    .orderBy(desc(knowledgeDocumentVersions.revision))
                    .limit(1)
                : [];
              // The document lock serializes simultaneous saves. Compare the
              // latest submission, not only published content: repeating a
              // pending or failed save is neither a new version nor a retry.
              if (
                latest &&
                latest.title === input.title &&
                latest.kind === input.kind &&
                latest.blobId === (content.blobId ?? null) &&
                latest.fileName === (content.fileName ?? null) &&
                latest.mediaType === (content.mediaType ?? null) &&
                latest.byteSize === (content.byteSize ?? null) &&
                latest.noteContent === (content.noteContent ?? null)
              )
                return { documentId, versionId: latest.id };
              const versionId = uuidv7();
              if (!input.documentId)
                yield* tx.insert(knowledgeDocuments).values({
                  id: documentId,
                  collectionId: input.collectionId,
                  title: input.title,
                  kind: input.kind,
                });
              else
                yield* tx
                  .update(knowledgeDocuments)
                  .set({ updatedAt: new Date() })
                  .where(eq(knowledgeDocuments.id, documentId));
              yield* tx.insert(knowledgeDocumentVersions).values({
                id: versionId,
                documentId,
                revision: (latest?.revision ?? 0) + 1,
                title: input.title,
                kind: input.kind,
                ...content,
              });
              // Capture upload-time consent, not whichever provider happens to
              // be enabled later when the extraction worker wakes up.
              if (target)
                yield* tx.insert(knowledgeEmbeddingJobs).values({
                  versionId,
                  spaceId: target.spaceId,
                  connectionRevision: target.connectionRevision,
                });
              return { documentId, versionId };
            }),
          )
          .pipe(Effect.orDie);

      const recoverExpiredJobs = Effect.fn("KnowledgeRepo.recoverExpiredJobs")(function* () {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Publication, retry and failure all lock the document before its
              // versions. SKIP LOCKED also avoids competing with a cascade.
              const documents = yield* tx
                .select({ id: knowledgeDocuments.id })
                .from(knowledgeDocuments)
                .where(sql`exists (select 1 from knowledge_document_versions v where v.document_id = ${knowledgeDocuments.id}
                  and v.attempts >= ${MAX_ATTEMPTS} and (v.status = 'queued' or (v.status = 'extracting' and (v.lease_until is null or v.lease_until < now()))))`)
                .orderBy(asc(knowledgeDocuments.id))
                .limit(50)
                .for("update", { skipLocked: true });
              const exhausted = yield* tx
                .update(knowledgeDocumentVersions)
                .set({
                  status: "failed",
                  leaseToken: null,
                  leaseUntil: null,
                  error: "extraction could not finish after three attempts; retry the document",
                })
                .where(
                  and(
                    inArray(
                      knowledgeDocumentVersions.documentId,
                      documents.map((document) => document.id),
                    ),
                    sql`${knowledgeDocumentVersions.attempts} >= ${MAX_ATTEMPTS}`,
                    or(
                      eq(knowledgeDocumentVersions.status, "queued"),
                      and(
                        eq(knowledgeDocumentVersions.status, "extracting"),
                        or(
                          isNull(knowledgeDocumentVersions.leaseUntil),
                          sql`${knowledgeDocumentVersions.leaseUntil} < now()`,
                        ),
                      ),
                    ),
                  ),
                )
                .returning({
                  id: knowledgeDocumentVersions.id,
                  documentId: knowledgeDocumentVersions.documentId,
                });
              for (const version of exhausted)
                yield* tx
                  .update(knowledgeDocuments)
                  .set({ currentVersionId: version.id })
                  .where(
                    and(
                      eq(knowledgeDocuments.id, version.documentId),
                      isNull(knowledgeDocuments.currentVersionId),
                    ),
                  );
              const embedded = yield* tx
                .update(knowledgeEmbeddingJobs)
                .set({
                  status: "failed",
                  leaseToken: null,
                  leaseUntil: null,
                  error: "embedding could not finish after three attempts; retry indexing",
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    sql`${knowledgeEmbeddingJobs.attempts} >= ${MAX_ATTEMPTS}`,
                    or(
                      eq(knowledgeEmbeddingJobs.status, "queued"),
                      and(
                        eq(knowledgeEmbeddingJobs.status, "running"),
                        or(
                          isNull(knowledgeEmbeddingJobs.leaseUntil),
                          sql`${knowledgeEmbeddingJobs.leaseUntil} < now()`,
                        ),
                      ),
                    ),
                  ),
                )
                .returning({ id: knowledgeEmbeddingJobs.versionId });
              return exhausted.length + embedded.length;
            }),
          )
          .pipe(Effect.orDie);
      });

      const claimExtraction = Effect.fn("KnowledgeRepo.claimExtraction")(function* () {
        const leaseToken = uuidv7();
        // `skip locked` keeps two workers from fighting over the same row; the
        // lease is what recovers a version whose worker died mid-parse.
        const rows = yield* db
          .execute(
            sql`
              update knowledge_document_versions
              set status = 'extracting',
                  lease_token = ${leaseToken},
                  lease_until = now() + interval '${sql.raw(String(LEASE_SECONDS))} seconds',
                  attempts = attempts + 1
              where id = (
                select id from knowledge_document_versions
                where attempts < ${MAX_ATTEMPTS} and (status = 'queued'
                   or (status = 'extracting' and (lease_until is null or lease_until < now())))
                order by created_at
                for update skip locked
                limit 1
              )
              returning id
            `,
          )
          .pipe(Effect.orDie);
        // Re-read through the typed select rather than mapping the raw result:
        // the update returns snake_case columns, and one shape for version rows
        // is worth the extra round trip on a background job.
        const claimedId = (rows as unknown as { rows: ReadonlyArray<{ id: string }> }).rows[0]?.id;
        if (!claimedId) return null;
        const versions = yield* db
          .select()
          .from(knowledgeDocumentVersions)
          .where(eq(knowledgeDocumentVersions.id, claimedId))
          .limit(1)
          .pipe(Effect.orDie);
        const version: VersionRow | undefined = versions[0];
        if (!version) return null;
        const blob = version.blobId
          ? yield* db
              .select({ storageKey: attachmentBlobs.storageKey })
              .from(attachmentBlobs)
              .where(eq(attachmentBlobs.id, version.blobId))
              .limit(1)
              .pipe(Effect.orDie)
          : [];
        return { version, storageKey: blob[0]?.storageKey ?? null, leaseToken };
      });

      const completeExtraction = Effect.fn("KnowledgeRepo.completeExtraction")(function* (input: {
        versionId: string;
        leaseToken: string;
        text: string;
        pageCount: number | null;
        truncated: { truncated: boolean; reason: string | null };
        chunks: ReadonlyArray<DocumentChunk>;
        /** Parser that produced the text; null for authored notes. */
        parsedWith?: string | null;
      }) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // `truncated` now also covers skipped scanned pages, which is
              // partial *coverage* of an otherwise complete extraction — the
              // text present is exact and citable, so it publishes. Only text
              // cut short by a size limit stays unpublishable (the worker
              // fails those before reaching here).
              if (
                !input.text.trim() ||
                input.text.length > KNOWLEDGE_LIMITS.maxExtractedChars ||
                input.chunks.length === 0 ||
                input.chunks.length > KNOWLEDGE_LIMITS.maxChunksPerVersion ||
                input.chunks.some(
                  (chunk) =>
                    chunk.startOffset < 0 ||
                    chunk.endOffset > input.text.length ||
                    chunk.startOffset >= chunk.endOffset ||
                    chunk.content !== input.text.slice(chunk.startOffset, chunk.endOffset),
                )
              )
                return false;
              const [version] = yield* tx
                .select({
                  documentId: knowledgeDocumentVersions.documentId,
                  revision: knowledgeDocumentVersions.revision,
                  title: knowledgeDocumentVersions.title,
                  kind: knowledgeDocumentVersions.kind,
                })
                .from(knowledgeDocumentVersions)
                .where(eq(knowledgeDocumentVersions.id, input.versionId));
              if (!version) return false;
              const [document] = yield* tx
                .select({ id: knowledgeDocuments.id })
                .from(knowledgeDocuments)
                .where(eq(knowledgeDocuments.id, version.documentId))
                .for("update");
              if (!document) return false;
              // The lease token is the fence: a worker whose lease expired and
              // was re-claimed must not publish over the newer attempt.
              const claimed = yield* tx
                .update(knowledgeDocumentVersions)
                .set({
                  status: "ready",
                  text: input.text,
                  pageCount: input.pageCount,
                  charCount: input.text.length,
                  pipelineFingerprint: pipelineFingerprint(input.parsedWith ?? null),
                  truncated: input.truncated,
                  error: null,
                  leaseToken: null,
                  leaseUntil: null,
                  readyAt: new Date(),
                })
                .where(
                  and(
                    eq(knowledgeDocumentVersions.id, input.versionId),
                    eq(knowledgeDocumentVersions.leaseToken, input.leaseToken),
                    eq(knowledgeDocumentVersions.status, "extracting"),
                    sql`${knowledgeDocumentVersions.leaseUntil} > now()`,
                  ),
                )
                .returning({ documentId: knowledgeDocumentVersions.documentId });
              const documentId = claimed[0]?.documentId;
              if (!documentId) return false;

              {
                yield* tx.insert(knowledgeChunks).values(
                  input.chunks.map((chunk, ordinal) => ({
                    id: uuidv7(),
                    versionId: input.versionId,
                    ordinal,
                    content: chunk.content,
                    headingPath: chunk.headingPath,
                    startOffset: chunk.startOffset,
                    endOffset: chunk.endOffset,
                    page: chunk.page,
                    tokens: chunk.tokens,
                  })),
                );
              }

              // Publishing the pointer last means a reader never sees a version
              // whose chunks are still being written.
              yield* tx
                .update(knowledgeDocuments)
                .set({
                  currentVersionId: input.versionId,
                  title: version.title,
                  kind: version.kind,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(knowledgeDocuments.id, documentId),
                    sql`not exists (
                  select 1 from knowledge_document_versions current
                  where current.id = ${knowledgeDocuments.currentVersionId} and current.revision > ${version.revision} and current.status = 'ready'
                )`,
                  ),
                );

              return true;
            }),
          )
          .pipe(Effect.orDie);
      });

      const failExtraction = Effect.fn("KnowledgeRepo.failExtraction")(function* (input: {
        versionId: string;
        leaseToken: string;
        error: string;
        retryable: boolean;
      }) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [version] = yield* tx
                .select({ documentId: knowledgeDocumentVersions.documentId })
                .from(knowledgeDocumentVersions)
                .where(eq(knowledgeDocumentVersions.id, input.versionId));
              if (!version) return;
              const [document] = yield* tx
                .select({ id: knowledgeDocuments.id })
                .from(knowledgeDocuments)
                .where(eq(knowledgeDocuments.id, version.documentId))
                .for("update");
              if (!document) return;
              const updated = yield* tx
                .update(knowledgeDocumentVersions)
                .set({
                  // A retryable failure goes back in the queue until attempts
                  // run out; an unsupported file is final and says so in the UI.
                  status: input.retryable
                    ? sql`case when ${knowledgeDocumentVersions.attempts} >= ${MAX_ATTEMPTS} then 'failed' else 'queued' end`
                    : "failed",
                  error: input.error,
                  leaseToken: null,
                  leaseUntil: null,
                })
                .where(
                  and(
                    eq(knowledgeDocumentVersions.id, input.versionId),
                    eq(knowledgeDocumentVersions.leaseToken, input.leaseToken),
                    eq(knowledgeDocumentVersions.status, "extracting"),
                    sql`${knowledgeDocumentVersions.leaseUntil} > now()`,
                  ),
                )
                .returning({
                  documentId: knowledgeDocumentVersions.documentId,
                  status: knowledgeDocumentVersions.status,
                });
              const failed = updated[0];
              if (!failed || failed.status !== "failed") return;
              // A first ingestion that failed still has to be visible as
              // failed. A failed *replacement* must not become current: the
              // document keeps the content it already had.
              yield* tx
                .update(knowledgeDocuments)
                .set({ currentVersionId: input.versionId, updatedAt: new Date() })
                .where(
                  and(
                    eq(knowledgeDocuments.id, failed.documentId),
                    isNull(knowledgeDocuments.currentVersionId),
                  ),
                );
            }),
          )
          .pipe(Effect.orDie);
      });

      const claimEmbedding = Effect.fn("KnowledgeRepo.claimEmbedding")(function* (
        spaceId: string,
        connectionRevision: string,
      ) {
        const leaseToken = uuidv7();
        const rows = yield* db
          .execute(
            sql`
              update knowledge_embedding_jobs
              set status = 'running',
                  lease_token = ${leaseToken},
                  lease_until = now() + interval '${sql.raw(String(LEASE_SECONDS))} seconds',
                  attempts = attempts + 1,
                  updated_at = now()
              where version_id = (
                select version_id from knowledge_embedding_jobs
                where space_id = ${spaceId} and connection_revision = ${connectionRevision} and attempts < ${MAX_ATTEMPTS}
                  and exists (select 1 from knowledge_document_versions v where v.id = version_id and v.status = 'ready')
                  and (
                    status = 'queued'
                    or (status = 'running' and (lease_until is null or lease_until < now()))
                  )
                order by updated_at
                for update skip locked
                limit 1
              )
              returning version_id
            `,
          )
          .pipe(Effect.orDie);
        const versionId = (rows as unknown as { rows: ReadonlyArray<{ version_id: string }> })
          .rows[0]?.version_id;
        if (!versionId) return null;
        const [owner] = yield* db
          .select({ ownerUserId: knowledgeCollections.userId })
          .from(knowledgeDocumentVersions)
          .innerJoin(
            knowledgeDocuments,
            eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
          )
          .innerJoin(
            knowledgeCollections,
            eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
          )
          .where(eq(knowledgeDocumentVersions.id, versionId))
          .pipe(Effect.orDie);
        return owner ? { versionId, leaseToken, ownerUserId: owner.ownerUserId } : null;
      });

      const renewEmbedding = Effect.fn("KnowledgeRepo.renewEmbedding")(function* (
        versionId: string,
        leaseToken: string,
        connectionRevision: string,
      ) {
        const rows = yield* db
          .update(knowledgeEmbeddingJobs)
          .set({ leaseUntil: sql`now() + interval '120 seconds'` })
          .where(
            and(
              eq(knowledgeEmbeddingJobs.versionId, versionId),
              eq(knowledgeEmbeddingJobs.leaseToken, leaseToken),
              eq(knowledgeEmbeddingJobs.connectionRevision, connectionRevision),
              eq(knowledgeEmbeddingJobs.status, "running"),
              sql`${knowledgeEmbeddingJobs.leaseUntil} > now()`,
            ),
          )
          .returning({ id: knowledgeEmbeddingJobs.versionId })
          .pipe(Effect.orDie);
        return rows.length > 0;
      });

      const listChunksForEmbedding = Effect.fn("KnowledgeRepo.listChunksForEmbedding")(function* (
        versionId: string,
      ) {
        return yield* db
          .select({
            id: knowledgeChunks.id,
            content: knowledgeChunks.content,
            headingPath: knowledgeChunks.headingPath,
            title: knowledgeDocumentVersions.title,
          })
          .from(knowledgeChunks)
          .innerJoin(
            knowledgeDocumentVersions,
            eq(knowledgeDocumentVersions.id, knowledgeChunks.versionId),
          )
          .innerJoin(
            knowledgeDocuments,
            eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
          )
          .where(eq(knowledgeChunks.versionId, versionId))
          .orderBy(asc(knowledgeChunks.ordinal))
          .pipe(Effect.orDie);
      });

      const completeEmbedding = Effect.fn("KnowledgeRepo.completeEmbedding")(function* (input: {
        versionId: string;
        leaseToken: string;
        spaceId: string;
        connectionRevision: string;
        dimensions: number;
        vectors: ReadonlyArray<{ chunkId: string; embedding: ReadonlyArray<number> }>;
      }) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const target = yield* readEmbeddingTarget(tx, true);
              if (
                !target ||
                target.spaceId !== input.spaceId ||
                target.connectionRevision !== input.connectionRevision ||
                target.dimensions !== input.dimensions
              )
                return false;
              // Match deletion's parent-before-job order. Otherwise a cascade
              // can hold the version while waiting for our job, and our vector
              // insert waits for that same version's foreign-key lock.
              const parent = yield* tx
                .select({ id: knowledgeDocumentVersions.id })
                .from(knowledgeDocumentVersions)
                .where(eq(knowledgeDocumentVersions.id, input.versionId))
                .for("key share");
              if (parent.length === 0) return false;
              const expected = yield* tx
                .select({ id: knowledgeChunks.id })
                .from(knowledgeChunks)
                .where(eq(knowledgeChunks.versionId, input.versionId));
              const ids = new Set(input.vectors.map((vector) => vector.chunkId));
              if (
                expected.length === 0 ||
                expected.length !== input.vectors.length ||
                ids.size !== expected.length ||
                expected.some((chunk) => !ids.has(chunk.id)) ||
                input.vectors.some(
                  (vector) =>
                    vector.embedding.length !== input.dimensions ||
                    !vector.embedding.every(Number.isFinite) ||
                    vector.embedding.every((value) => value === 0),
                )
              )
                return false;
              // Both the lease and the target space are checked: a job
              // re-targeted mid-run must not be published into the old space.
              const claimed = yield* tx
                .update(knowledgeEmbeddingJobs)
                .set({
                  status: "ready",
                  leaseToken: null,
                  leaseUntil: null,
                  error: null,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(knowledgeEmbeddingJobs.versionId, input.versionId),
                    eq(knowledgeEmbeddingJobs.leaseToken, input.leaseToken),
                    eq(knowledgeEmbeddingJobs.spaceId, input.spaceId),
                    eq(knowledgeEmbeddingJobs.connectionRevision, input.connectionRevision),
                    eq(knowledgeEmbeddingJobs.status, "running"),
                    sql`${knowledgeEmbeddingJobs.leaseUntil} > now()`,
                  ),
                )
                .returning({ versionId: knowledgeEmbeddingJobs.versionId });
              if (claimed.length === 0) return false;

              // Bound statement payloads even for 8192-wide vectors. All batches
              // remain inside the same lease/connection-fenced transaction.
              for (let offset = 0; offset < input.vectors.length; offset += 32) {
                yield* tx
                  .insert(knowledgeChunkEmbeddings)
                  .values(
                    input.vectors.slice(offset, offset + 32).map((vector) => ({
                      chunkId: vector.chunkId,
                      versionId: input.versionId,
                      spaceId: input.spaceId,
                      dimensions: input.dimensions,
                      embedding: [...vector.embedding],
                    })),
                  )
                  .onConflictDoUpdate({
                    target: knowledgeChunkEmbeddings.chunkId,
                    set: {
                      spaceId: sql`excluded.space_id`,
                      dimensions: sql`excluded.dimensions`,
                      embedding: sql`excluded.embedding`,
                      versionId: sql`excluded.version_id`,
                    },
                  });
              }
              return true;
            }),
          )
          .pipe(Effect.orDie);
      });

      const failEmbedding = Effect.fn("KnowledgeRepo.failEmbedding")(function* (input: {
        versionId: string;
        leaseToken: string;
        error: string;
        retryable: boolean;
      }) {
        yield* db
          .update(knowledgeEmbeddingJobs)
          .set({
            status: input.retryable
              ? sql`case when ${knowledgeEmbeddingJobs.attempts} >= ${MAX_ATTEMPTS} then 'failed' else 'queued' end`
              : "failed",
            error: input.error,
            leaseToken: null,
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(knowledgeEmbeddingJobs.versionId, input.versionId),
              eq(knowledgeEmbeddingJobs.leaseToken, input.leaseToken),
              eq(knowledgeEmbeddingJobs.status, "running"),
              sql`${knowledgeEmbeddingJobs.leaseUntil} > now()`,
            ),
          )
          .pipe(Effect.orDie);
      });

      const rebuildCollectionContent = Effect.fn("KnowledgeRepo.rebuildCollectionContent")(
        function* (
          userId: string,
          collectionId: string,
          currentFingerprints: ReadonlyArray<string>,
          pdfAvailable?: boolean,
        ) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [owned] = yield* tx
                  .select({ id: knowledgeCollections.id })
                  .from(knowledgeCollections)
                  .where(ownedCollection(userId, collectionId))
                  .limit(1)
                  .for("update");
                if (!owned) return 0;
                const target = yield* readEmbeddingTarget(tx, true);
                // Only published versions are rebuilt, and only from a source
                // this row still carries: a document mid-replacement is left to
                // finish rather than forked again.
                const stale = yield* tx
                  .select({
                    documentId: knowledgeDocuments.id,
                    title: knowledgeDocumentVersions.title,
                    kind: knowledgeDocumentVersions.kind,
                    blobId: knowledgeDocumentVersions.blobId,
                    fileName: knowledgeDocumentVersions.fileName,
                    mediaType: knowledgeDocumentVersions.mediaType,
                    byteSize: knowledgeDocumentVersions.byteSize,
                    noteContent: knowledgeDocumentVersions.noteContent,
                    revision: knowledgeDocumentVersions.revision,
                  })
                  .from(knowledgeDocuments)
                  .innerJoin(
                    knowledgeDocumentVersions,
                    eq(knowledgeDocumentVersions.id, knowledgeDocuments.currentVersionId),
                  )
                  .where(
                    and(
                      eq(knowledgeDocuments.collectionId, collectionId),
                      eq(knowledgeDocumentVersions.status, "ready"),
                      pdfAvailable === false
                        ? or(
                            isNull(knowledgeDocumentVersions.mediaType),
                            ne(knowledgeDocumentVersions.mediaType, "application/pdf"),
                          )
                        : undefined,
                      // A note, a text file and a PDF each have their own
                      // pipeline identity; anything the current one cannot
                      // produce predates it.
                      or(
                        isNull(knowledgeDocumentVersions.pipelineFingerprint),
                        notInArray(knowledgeDocumentVersions.pipelineFingerprint, [
                          ...currentFingerprints,
                        ]),
                      ),
                      // The latest revision must be the published one; a queued
                      // or failed replacement already owns this document's future.
                      sql`${knowledgeDocumentVersions.revision} = (
                        select max(v.revision) from ${knowledgeDocumentVersions} v
                        where v.document_id = ${knowledgeDocuments.id}
                      )`,
                    ),
                  )
                  .for("update", { of: knowledgeDocuments });
                if (stale.length === 0) return 0;
                const blobIds = [
                  ...new Set(stale.flatMap((row) => (row.blobId ? [row.blobId] : []))),
                ];
                yield* lockBlobs(tx, blobIds);
                for (const row of stale) {
                  const versionId = uuidv7();
                  yield* tx.insert(knowledgeDocumentVersions).values({
                    id: versionId,
                    documentId: row.documentId,
                    revision: row.revision + 1,
                    title: row.title,
                    kind: row.kind,
                    blobId: row.blobId,
                    fileName: row.fileName,
                    mediaType: row.mediaType,
                    byteSize: row.byteSize,
                    noteContent: row.noteContent,
                  });
                  if (target)
                    yield* tx.insert(knowledgeEmbeddingJobs).values({
                      versionId,
                      spaceId: target.spaceId,
                      connectionRevision: target.connectionRevision,
                    });
                }
                return stale.length;
              }),
            )
            .pipe(Effect.orDie);
        },
      );

      const isAdmin = Effect.fn("KnowledgeRepo.isAdmin")(function* (userId: string) {
        const [actor] = yield* db
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, userId))
          .pipe(Effect.orDie);
        return actor?.role === "admin";
      });

      const listAllCollectionIds = Effect.fn("KnowledgeRepo.listAllCollectionIds")(function* () {
        return yield* db
          .select({ id: knowledgeCollections.id, userId: knowledgeCollections.userId })
          .from(knowledgeCollections)
          .orderBy(asc(knowledgeCollections.id))
          .pipe(Effect.orDie);
      });

      const reindexCollection = Effect.fn("KnowledgeRepo.reindexCollection")(function* (
        userId: string,
        collectionId: string,
        options: { staleOnly?: boolean } = {},
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const target = yield* readEmbeddingTarget(tx, true);
              if (!target) return 0;
              const [owned] = yield* tx
                .select({ id: knowledgeCollections.id })
                .from(knowledgeCollections)
                .where(ownedCollection(userId, collectionId))
                .for("update");
              if (!owned) return 0;
              // Old retained versions are also citable. Reindex only this owner's
              // explicit collection selection, never every user's private corpus.
              const versions = yield* tx
                .select({ id: knowledgeDocumentVersions.id })
                .from(knowledgeDocumentVersions)
                .innerJoin(
                  knowledgeDocuments,
                  eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
                )
                .leftJoin(
                  knowledgeEmbeddingJobs,
                  eq(knowledgeEmbeddingJobs.versionId, knowledgeDocumentVersions.id),
                )
                .where(
                  and(
                    eq(knowledgeDocuments.collectionId, collectionId),
                    inArray(knowledgeDocumentVersions.status, ["ready", "queued", "extracting"]),
                    options.staleOnly
                      ? or(
                          isNull(knowledgeEmbeddingJobs.versionId),
                          ne(knowledgeEmbeddingJobs.spaceId, target.spaceId),
                          eq(knowledgeEmbeddingJobs.status, "failed"),
                          and(
                            ne(knowledgeEmbeddingJobs.status, "ready"),
                            ne(
                              knowledgeEmbeddingJobs.connectionRevision,
                              target.connectionRevision,
                            ),
                          ),
                        )
                      : undefined,
                  ),
                );
              for (const version of versions) {
                yield* tx
                  .insert(knowledgeEmbeddingJobs)
                  .values({
                    versionId: version.id,
                    spaceId: target.spaceId,
                    connectionRevision: target.connectionRevision,
                  })
                  .onConflictDoUpdate({
                    target: knowledgeEmbeddingJobs.versionId,
                    set: {
                      spaceId: target.spaceId,
                      connectionRevision: target.connectionRevision,
                      status: "queued",
                      attempts: 0,
                      error: null,
                      leaseToken: null,
                      leaseUntil: null,
                      updatedAt: new Date(),
                    },
                  });
              }
              return versions.length;
            }),
          )
          .pipe(Effect.orDie);
      });

      const resolveManifest = Effect.fn("KnowledgeRepo.resolveManifest")(function* (
        userId: string,
        collectionIds: ReadonlyArray<string>,
        // Resolving inside the turn's transaction is what makes the saved
        // manifest a snapshot of one instant rather than of several reads.
        tx?: DbTx,
      ) {
        if (collectionIds.length === 0) return [];
        const rows = yield* (tx ?? db)
          .select({
            collectionId: knowledgeCollections.id,
            documentId: knowledgeDocuments.id,
            title: knowledgeDocuments.title,
            versionId: knowledgeDocumentVersions.id,
            status: knowledgeDocumentVersions.status,
            charCount: knowledgeDocumentVersions.charCount,
            truncated: knowledgeDocumentVersions.truncated,
          })
          .from(knowledgeCollections)
          .leftJoin(
            knowledgeDocuments,
            eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
          )
          .leftJoin(knowledgeDocumentVersions, eq(knowledgeDocumentVersions.id, displayedVersionId))
          .where(
            and(inArray(knowledgeCollections.id, [...collectionIds]), collectionReadable(userId)),
          )
          .orderBy(asc(knowledgeDocuments.title), asc(knowledgeDocuments.id))
          .pipe(Effect.orDie);

        const available = new Set(rows.map((row) => row.collectionId));
        for (const id of collectionIds)
          if (!available.has(id)) return yield* new KnowledgeNotAvailable({ resourceId: id });
        return rows.flatMap((row): ManifestEntry[] =>
          row.documentId === null
            ? []
            : [
                {
                  collectionId: row.collectionId,
                  documentId: row.documentId,
                  versionId: row.status === "ready" ? row.versionId : null,
                  title: row.title!,
                  status:
                    row.status === "ready"
                      ? "ready"
                      : row.status === "failed"
                        ? "failed"
                        : "pending",
                  charCount: row.charCount,
                  truncated: row.truncated?.truncated ?? false,
                },
              ],
        );
      });

      const authorizeVersions = Effect.fn("KnowledgeRepo.authorizeVersions")(function* (
        userId: string,
        versionIds: ReadonlyArray<string>,
      ) {
        if (versionIds.length === 0) return;
        const rows = yield* db
          .select({ id: knowledgeDocumentVersions.id })
          .from(knowledgeDocumentVersions)
          .innerJoin(
            knowledgeDocuments,
            eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
          )
          .innerJoin(
            knowledgeCollections,
            eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
          )
          .where(
            and(
              inArray(knowledgeDocumentVersions.id, [...versionIds]),
              eq(knowledgeDocumentVersions.status, "ready"),
              collectionReadable(userId),
            ),
          )
          .pipe(Effect.orDie);
        const readable = new Set(rows.map((row) => row.id));
        for (const id of versionIds)
          if (!readable.has(id)) return yield* new KnowledgeNotAvailable({ resourceId: id });
      });

      const authorizeManifest = Effect.fn("KnowledgeRepo.authorizeManifest")(function* (
        userId: string,
        collectionIds: ReadonlyArray<string>,
        manifest: ReadonlyArray<ManifestEntry>,
        tx?: DbTx,
      ) {
        const documentIds = manifest.map((entry) => entry.documentId);
        const versionIds = manifest.flatMap((entry) => (entry.versionId ? [entry.versionId] : []));
        // One SQL snapshot includes empty collections, pending documents and old
        // versions. Never substitute a current version for a saved identity.
        const rows =
          collectionIds.length === 0
            ? []
            : yield* (tx ?? db)
                .select({
                  collectionId: knowledgeCollections.id,
                  documentId: knowledgeDocuments.id,
                  versionId: knowledgeDocumentVersions.id,
                  status: knowledgeDocumentVersions.status,
                })
                .from(knowledgeCollections)
                .leftJoin(
                  knowledgeDocuments,
                  and(
                    eq(knowledgeDocuments.collectionId, knowledgeCollections.id),
                    inArray(knowledgeDocuments.id, documentIds),
                  ),
                )
                .leftJoin(
                  knowledgeDocumentVersions,
                  and(
                    eq(knowledgeDocumentVersions.documentId, knowledgeDocuments.id),
                    inArray(knowledgeDocumentVersions.id, versionIds),
                  ),
                )
                .where(
                  and(
                    inArray(knowledgeCollections.id, [...collectionIds]),
                    collectionReadable(userId),
                  ),
                )
                .pipe(Effect.orDie);
        const readableCollections = new Set(rows.map((row) => row.collectionId));
        const documents = new Set(
          rows
            .filter((row) => row.documentId)
            .map((row) => JSON.stringify([row.collectionId, row.documentId])),
        );
        const versions = new Set(
          rows
            .filter((row) => row.versionId && row.status === "ready")
            .map((row) => JSON.stringify([row.collectionId, row.documentId, row.versionId])),
        );
        for (const id of collectionIds)
          if (!readableCollections.has(id))
            return yield* new KnowledgeNotAvailable({ resourceId: id });
        for (const entry of manifest) {
          if (
            !documents.has(JSON.stringify([entry.collectionId, entry.documentId])) ||
            (entry.versionId !== null &&
              !versions.has(
                JSON.stringify([entry.collectionId, entry.documentId, entry.versionId]),
              ))
          )
            return yield* new KnowledgeNotAvailable({ resourceId: entry.documentId });
        }
      });

      const searchLexical = Effect.fn("KnowledgeRepo.searchLexical")(function* (
        versionIds: ReadonlyArray<string>,
        query: string,
        limit: number,
      ) {
        if (versionIds.length === 0 || query.trim().length === 0) return [];
        const rows = yield* db
          .select({
            chunkId: knowledgeChunks.id,
            rank: sql<number>`ts_rank_cd(${knowledgeChunks.searchVector}, websearch_to_tsquery('english', ${query}))`,
          })
          .from(knowledgeChunks)
          .where(
            and(
              inArray(knowledgeChunks.versionId, [...versionIds]),
              sql`${knowledgeChunks.searchVector} @@ websearch_to_tsquery('english', ${query})`,
            ),
          )
          .orderBy(
            desc(
              sql`ts_rank_cd(${knowledgeChunks.searchVector}, websearch_to_tsquery('english', ${query}))`,
            ),
          )
          .limit(limit)
          .pipe(Effect.orDie);
        return rows.map((row) => ({ chunkId: row.chunkId, rank: Number(row.rank) }));
      });

      const semanticVersionCount = Effect.fn("KnowledgeRepo.semanticVersionCount")(function* (
        versionIds: ReadonlyArray<string>,
        spaceId: string,
      ) {
        if (!versionIds.length) return 0;
        const [row] = yield* db
          .select({
            total: sql<number>`count(distinct ${knowledgeChunkEmbeddings.versionId})::int`,
          })
          .from(knowledgeChunkEmbeddings)
          .where(
            and(
              inArray(knowledgeChunkEmbeddings.versionId, [...versionIds]),
              eq(knowledgeChunkEmbeddings.spaceId, spaceId),
            ),
          )
          .pipe(Effect.orDie);
        return row?.total ?? 0;
      });

      const searchSemantic = Effect.fn("KnowledgeRepo.searchSemantic")(function* (input: {
        versionIds: ReadonlyArray<string>;
        spaceId: string;
        embedding: ReadonlyArray<number>;
        limit: number;
      }) {
        if (input.versionIds.length === 0 || input.embedding.length === 0) return [];
        const literal = `[${input.embedding.join(",")}]`;
        const rows = yield* db
          .select({
            chunkId: knowledgeChunkEmbeddings.chunkId,
            // Cosine distance; smaller is nearer. Restricted to one space so
            // every vector compared here has the same width and geometry.
            distance: sql<number>`${knowledgeChunkEmbeddings.embedding} <=> ${literal}::vector`,
          })
          .from(knowledgeChunkEmbeddings)
          .where(
            and(
              inArray(knowledgeChunkEmbeddings.versionId, [...input.versionIds]),
              eq(knowledgeChunkEmbeddings.spaceId, input.spaceId),
              eq(knowledgeChunkEmbeddings.dimensions, input.embedding.length),
            ),
          )
          .orderBy(asc(sql`${knowledgeChunkEmbeddings.embedding} <=> ${literal}::vector`))
          .limit(input.limit)
          .pipe(Effect.orDie);
        return rows.map((row) => ({ chunkId: row.chunkId, rank: 1 - Number(row.distance) }));
      });

      const loadPassages = Effect.fn("KnowledgeRepo.loadPassages")(function* (
        chunkIds: ReadonlyArray<string>,
      ) {
        if (chunkIds.length === 0) return [];
        const rows = yield* db
          .select({
            chunkId: knowledgeChunks.id,
            versionId: knowledgeChunks.versionId,
            content: knowledgeChunks.content,
            headingPath: knowledgeChunks.headingPath,
            page: knowledgeChunks.page,
            startOffset: knowledgeChunks.startOffset,
            endOffset: knowledgeChunks.endOffset,
            documentId: knowledgeDocuments.id,
            collectionId: knowledgeDocuments.collectionId,
            title: knowledgeDocumentVersions.title,
          })
          .from(knowledgeChunks)
          .innerJoin(
            knowledgeDocumentVersions,
            eq(knowledgeDocumentVersions.id, knowledgeChunks.versionId),
          )
          .innerJoin(
            knowledgeDocuments,
            eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
          )
          .where(inArray(knowledgeChunks.id, [...chunkIds]))
          .pipe(Effect.orDie);
        const byId = new Map(rows.map((row) => [row.chunkId, row]));
        return chunkIds.flatMap((id): KnowledgePassage[] => {
          const row = byId.get(id);
          return row ? [{ ...row, page: row.page ?? null }] : [];
        });
      });

      const readVersionRange = Effect.fn("KnowledgeRepo.readVersionRange")(function* (
        versionId: string,
        startOffset: number,
        endOffset: number,
      ) {
        if (startOffset === endOffset) return "";
        // PostgreSQL substring counts code points, while citations count UTF-16.
        // Walk bounded blocks in the database, adding one unit for each non-BMP
        // character. Only intersecting blocks cross the connection, including
        // whitespace omitted by search chunks. The final cut stays in JavaScript.
        const nonSupplementary = "[^\u{10000}-\u{10ffff}]";
        const rows = yield* db
          .select({
            content: sql<string>`ranges.content`,
            startOffset: sql<number>`ranges.start_offset`,
          })
          .from(sql`(
          with recursive document as materialized (
            select text from knowledge_document_versions where id = ${versionId} and text is not null
          ), blocks as (
            select 1 as position, 0 as start_offset, substring(text from 1 for 4096) as content
            from document
            union all
            select b.position + 4096, b.start_offset + w.units,
              substring(d.text from b.position + 4096 for 4096)
            from blocks b cross join document d
            cross join lateral (
              select length(b.content) + length(regexp_replace(b.content, ${nonSupplementary}, '', 'g')) as units
            ) w
            where length(b.content) = 4096 and b.start_offset + w.units < ${endOffset}
          )
          select content, start_offset from blocks
          where start_offset < ${endOffset}
            and start_offset + length(content) + length(regexp_replace(content, ${nonSupplementary}, '', 'g')) > ${startOffset}
        ) ranges`)
          .orderBy(sql`ranges.start_offset`)
          .pipe(Effect.orDie);
        const first = rows[0];
        if (!first) return null;
        const text = rows.map((row) => row.content).join("");
        const from = startOffset - first.startOffset;
        const to = endOffset - first.startOffset;
        return from >= 0 && to <= text.length ? text.slice(from, to) : null;
      });

      const readVersionBodiesForAccess = Effect.fn("KnowledgeRepo.readVersionBodiesForAccess")(
        function* (userId: string, references: ReadonlyArray<VersionBodyReference>) {
          const bodies: VersionBody[] = [];
          for (let offset = 0; offset < references.length; offset += 32) {
            const batch = references.slice(offset, offset + 32);
            const rows = yield* db
              .select({
                collectionId: knowledgeCollections.id,
                documentId: knowledgeDocuments.id,
                versionId: knowledgeDocumentVersions.id,
                title: knowledgeDocumentVersions.title,
                text: knowledgeDocumentVersions.text,
                charCount: knowledgeDocumentVersions.charCount,
              })
              .from(knowledgeDocumentVersions)
              .innerJoin(
                knowledgeDocuments,
                eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
              )
              .innerJoin(
                knowledgeCollections,
                eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
              )
              .where(
                and(
                  collectionReadable(userId),
                  eq(knowledgeDocumentVersions.status, "ready"),
                  or(
                    ...batch.map((reference) =>
                      and(
                        eq(knowledgeDocumentVersions.id, reference.versionId),
                        eq(knowledgeDocuments.id, reference.documentId),
                        eq(knowledgeCollections.id, reference.collectionId),
                        eq(knowledgeDocumentVersions.charCount, reference.charCount),
                      ),
                    ),
                  ),
                ),
              )
              .pipe(Effect.orDie);
            for (const row of rows) {
              if (row.text !== null && row.charCount !== null)
                bodies.push({ ...row, text: row.text, charCount: row.charCount });
            }
          }
          return bodies;
        },
      );

      return KnowledgeRepo.of({
        listCollections,
        getCollection,
        createCollection,
        updateCollection,
        deleteCollection,
        listDocuments,
        addFileDocument: (userId, input) =>
          insertDocument(userId, {
            collectionId: input.collectionId,
            title: input.title,
            kind: "file",
            version: {
              blobId: input.blobId,
              fileName: input.fileName,
              mediaType: input.mediaType,
              byteSize: input.byteSize,
            },
          }),
        addNoteDocument: (userId, input) =>
          insertDocument(userId, {
            collectionId: input.collectionId,
            title: input.title,
            kind: "note",
            version: { noteContent: input.content },
          }),
        replaceFileDocument: (userId, input) =>
          insertDocument(userId, {
            collectionId: input.collectionId,
            documentId: input.documentId,
            title: input.title,
            kind: "file",
            version: {
              blobId: input.blobId,
              fileName: input.fileName,
              mediaType: input.mediaType,
              byteSize: input.byteSize,
            },
          }),
        replaceNoteDocument: (userId, input) =>
          insertDocument(userId, {
            collectionId: input.collectionId,
            documentId: input.documentId,
            title: input.title,
            kind: "note",
            version: { noteContent: input.content },
          }),
        retryDocument: (userId, documentId) =>
          db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [collection] = yield* tx
                  .select({ id: knowledgeCollections.id })
                  .from(knowledgeCollections)
                  .innerJoin(
                    knowledgeDocuments,
                    eq(knowledgeDocuments.collectionId, knowledgeCollections.id),
                  )
                  .where(
                    and(
                      eq(knowledgeDocuments.id, documentId),
                      eq(knowledgeCollections.userId, userId),
                    ),
                  )
                  .for("update", { of: knowledgeCollections });
                if (!collection) return false;
                yield* tx
                  .select({ id: knowledgeDocuments.id })
                  .from(knowledgeDocuments)
                  .where(eq(knowledgeDocuments.id, documentId))
                  .for("update");
                const [latest] = yield* tx
                  .select({
                    id: knowledgeDocumentVersions.id,
                    status: knowledgeDocumentVersions.status,
                  })
                  .from(knowledgeDocumentVersions)
                  .where(eq(knowledgeDocumentVersions.documentId, documentId))
                  .orderBy(desc(knowledgeDocumentVersions.revision))
                  .limit(1);
                if (!latest || latest.status !== "failed") return false;
                const retried = yield* tx
                  .update(knowledgeDocumentVersions)
                  .set({
                    status: "queued",
                    attempts: 0,
                    error: null,
                    leaseToken: null,
                    leaseUntil: null,
                  })
                  .where(
                    and(
                      eq(knowledgeDocumentVersions.id, latest.id),
                      eq(knowledgeDocumentVersions.status, "failed"),
                    ),
                  )
                  .returning({ id: knowledgeDocumentVersions.id });
                return retried.length > 0;
              }),
            )
            .pipe(Effect.orDie),
        deleteDocument: Effect.fn("KnowledgeRepo.deleteDocument")(function* (userId, documentId) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [collection] = yield* tx
                  .select({ id: knowledgeCollections.id })
                  .from(knowledgeCollections)
                  .innerJoin(
                    knowledgeDocuments,
                    eq(knowledgeDocuments.collectionId, knowledgeCollections.id),
                  )
                  .where(
                    and(
                      eq(knowledgeDocuments.id, documentId),
                      eq(knowledgeCollections.userId, userId),
                    ),
                  )
                  .for("update", { of: knowledgeCollections });
                if (!collection) return [] as string[];
                const owned = yield* tx
                  .select({
                    documentId: knowledgeDocuments.id,
                    blobId: knowledgeDocumentVersions.blobId,
                  })
                  .from(knowledgeDocuments)
                  .innerJoin(
                    knowledgeCollections,
                    eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
                  )
                  .leftJoin(
                    knowledgeDocumentVersions,
                    eq(knowledgeDocumentVersions.documentId, knowledgeDocuments.id),
                  )
                  .where(
                    and(
                      eq(knowledgeDocuments.id, documentId),
                      eq(knowledgeCollections.userId, userId),
                    ),
                  );
                if (owned.length === 0) return [] as string[];
                const blobIds = [
                  ...new Set(owned.flatMap((row) => (row.blobId ? [row.blobId] : []))),
                ];
                yield* lockBlobs(tx, blobIds);
                yield* tx
                  .update(knowledgeDocuments)
                  .set({ currentVersionId: null })
                  .where(eq(knowledgeDocuments.id, documentId));
                yield* tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId));
                return yield* collectOrphanedBlobs(tx, blobIds);
              }),
            )
            .pipe(Effect.orDie);
        }),
        recoverExpiredJobs,
        claimExtraction,
        completeExtraction,
        failExtraction,
        claimEmbedding,
        listChunksForEmbedding,
        renewEmbedding,
        completeEmbedding,
        failEmbedding,
        isAdmin,
        listAllCollectionIds,
        reindexCollection,
        rebuildCollectionContent,
        resolveManifest,
        authorizeVersions,
        authorizeManifest,
        searchLexical,
        searchSemantic,
        semanticVersionCount,
        loadPassages,
        readVersionRange,
        readVersionBodiesForAccess,
        documentCollection: (userId, documentId) =>
          db
            .select({
              collectionId: knowledgeCollections.id,
              canEdit: sql<boolean>`${knowledgeCollections.userId} = ${userId}`,
            })
            .from(knowledgeDocuments)
            .innerJoin(
              knowledgeCollections,
              eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
            )
            .where(and(eq(knowledgeDocuments.id, documentId), collectionReadable(userId)))
            .pipe(
              Effect.map((rows) => rows[0] ?? null),
              Effect.orDie,
            ),
        readVersionForAccess: (userId, reference) =>
          db
            .select({
              title: knowledgeDocumentVersions.title,
              status: knowledgeDocumentVersions.status,
              charCount: knowledgeDocumentVersions.charCount,
              fileName: knowledgeDocumentVersions.fileName,
              mediaType: attachmentBlobs.mediaType,
              storageKey: attachmentBlobs.storageKey,
            })
            .from(knowledgeDocumentVersions)
            .innerJoin(
              knowledgeDocuments,
              eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
            )
            .innerJoin(
              knowledgeCollections,
              eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
            )
            .leftJoin(attachmentBlobs, eq(attachmentBlobs.id, knowledgeDocumentVersions.blobId))
            .where(
              and(
                eq(knowledgeDocumentVersions.id, reference.versionId),
                eq(knowledgeDocuments.id, reference.documentId),
                eq(knowledgeCollections.id, reference.collectionId),
                collectionReadable(userId),
              ),
            )
            .pipe(
              Effect.map((rows) => rows[0] ?? null),
              Effect.orDie,
            ),
      });
    }),
  );
}
