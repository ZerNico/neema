import { leaseFor } from "~/server/sql.ts";
import { notifyOnCommit } from "~/modules/sync/server/signals.ts";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import {
  attachmentBlobs,
  knowledgeChunkEmbeddings,
  knowledgeChunks,
  knowledgeCollections,
  knowledgeDocumentVersions,
  knowledgeDocuments,
  knowledgeEmbeddingJobs,
} from "~/db/schema/index.ts";
import type { Db } from "~/server/db.ts";
import { KNOWLEDGE_LIMITS } from "../schema.ts";
import { pipelineFingerprint, type DocumentChunk } from "./chunking.ts";
import { readEmbeddingTarget } from "./embedding-connection.ts";
import type { KnowledgeRepo } from "./repo.ts";

type VersionRow = typeof knowledgeDocumentVersions.$inferSelect;

/** How long a claimed extraction/embedding job is protected from re-claiming. */
const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 3;
export const MAX_EXTRACTION_ATTEMPTS = MAX_ATTEMPTS;

/**
 * The indexing workers' side of the knowledge repo: claiming, renewing,
 * completing and failing extraction and embedding jobs under their leases.
 */
export const indexingJobs = (db: Db["Service"]) => {
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
              and v.attempts >= ${MAX_ATTEMPTS} and (v.status = 'queued' or (v.status = 'extracting' and (v.lease_until is null or v.lease_until <= clock_timestamp()))))`)
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
                      sql`${knowledgeDocumentVersions.leaseUntil} <= clock_timestamp()`,
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
                      sql`${knowledgeEmbeddingJobs.leaseUntil} <= clock_timestamp()`,
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
      .execute<{ id: string }>(
        sql`
          update knowledge_document_versions
          set status = 'extracting',
              lease_token = ${leaseToken},
              lease_until = ${leaseFor(LEASE_SECONDS)},
              attempts = attempts + 1
          where id = (
            select id from knowledge_document_versions
            where attempts < ${MAX_ATTEMPTS}
              -- On a queued row lease_until is the earliest retry, set by a
              -- failure worth waiting out (a scan reader's rate limit).
              and ((status = 'queued' and (lease_until is null or lease_until <= clock_timestamp()))
               or (status = 'extracting' and (lease_until is null or lease_until <= clock_timestamp())))
            order by created_at
            for update skip locked
            limit 1
          )
          returning id
        `,
        "objects",
      )
      .pipe(Effect.orDie);
    // Re-read through the typed select rather than mapping the raw result:
    // the update returns snake_case columns, and one shape for version rows
    // is worth the extra round trip on a background job.
    const claimedId = rows[0]?.id;
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
    const [owner] = yield* db
      .select({ ownerUserId: knowledgeCollections.userId })
      .from(knowledgeDocuments)
      .innerJoin(knowledgeCollections, eq(knowledgeCollections.id, knowledgeDocuments.collectionId))
      .where(eq(knowledgeDocuments.id, version.documentId))
      .pipe(Effect.orDie);
    return {
      version,
      storageKey: blob[0]?.storageKey ?? null,
      leaseToken,
      ownerUserId: owner?.ownerUserId ?? null,
    };
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
          // partial *coverage* of an otherwise complete extraction. The
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
                sql`${knowledgeDocumentVersions.leaseUntil} > clock_timestamp()`,
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

          yield* notifyOnCommit(tx, {
            scope: "internal",
            event: { type: "knowledge.work", stage: "embedding" },
          });
          return true;
        }),
      )
      .pipe(Effect.orDie);
  });

  const renewExtractionLease = Effect.fn("KnowledgeRepo.renewExtractionLease")(function* (input: {
    versionId: string;
    leaseToken: string;
  }) {
    const renewed = yield* db
      .update(knowledgeDocumentVersions)
      .set({
        leaseUntil: leaseFor(LEASE_SECONDS),
      })
      .where(
        and(
          eq(knowledgeDocumentVersions.id, input.versionId),
          eq(knowledgeDocumentVersions.leaseToken, input.leaseToken),
          eq(knowledgeDocumentVersions.status, "extracting"),
          sql`${knowledgeDocumentVersions.leaseUntil} > clock_timestamp()`,
        ),
      )
      .returning({ id: knowledgeDocumentVersions.id })
      .pipe(Effect.orDie);
    return renewed.length > 0;
  });

  const failExtraction = Effect.fn("KnowledgeRepo.failExtraction")(function* (input: {
    versionId: string;
    leaseToken: string;
    error: string;
    retryable: boolean;
    retryAfterMs?: number;
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
              // Judged by the database clock, like every lease.
              leaseUntil:
                input.retryable && input.retryAfterMs
                  ? sql`now() + make_interval(secs => ${input.retryAfterMs / 1000})`
                  : null,
            })
            .where(
              and(
                eq(knowledgeDocumentVersions.id, input.versionId),
                eq(knowledgeDocumentVersions.leaseToken, input.leaseToken),
                eq(knowledgeDocumentVersions.status, "extracting"),
                sql`${knowledgeDocumentVersions.leaseUntil} > clock_timestamp()`,
              ),
            )
            .returning({
              documentId: knowledgeDocumentVersions.documentId,
              status: knowledgeDocumentVersions.status,
            });
          const failed = updated[0];
          if (failed?.status === "queued")
            yield* notifyOnCommit(tx, {
              scope: "internal",
              event: { type: "knowledge.work", stage: "extraction" },
            });
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
      .execute<{ version_id: string; attempts: number }>(
        sql`
          update knowledge_embedding_jobs
          set status = 'running',
              lease_token = ${leaseToken},
              lease_until = ${leaseFor(LEASE_SECONDS)},
              attempts = attempts + 1,
              updated_at = now()
          where version_id = (
            select version_id from knowledge_embedding_jobs
            where space_id = ${spaceId} and connection_revision = ${connectionRevision} and attempts < ${MAX_ATTEMPTS}
              and (not_before is null or not_before <= now())
              and exists (select 1 from knowledge_document_versions v where v.id = version_id and v.status = 'ready')
              and (
                status = 'queued'
                or (status = 'running' and (lease_until is null or lease_until <= clock_timestamp()))
              )
            order by updated_at
            for update skip locked
            limit 1
          )
          returning version_id, attempts
        `,
        "objects",
      )
      .pipe(Effect.orDie);
    const claimed = rows[0];
    const versionId = claimed?.version_id;
    if (!versionId) return null;
    const [owner] = yield* db
      .select({ ownerUserId: knowledgeCollections.userId })
      .from(knowledgeDocumentVersions)
      .innerJoin(
        knowledgeDocuments,
        eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
      )
      .innerJoin(knowledgeCollections, eq(knowledgeCollections.id, knowledgeDocuments.collectionId))
      .where(eq(knowledgeDocumentVersions.id, versionId))
      .pipe(Effect.orDie);
    return owner
      ? {
          versionId,
          leaseToken,
          ownerUserId: owner.ownerUserId,
          attempts: claimed?.attempts ?? 1,
        }
      : null;
  });

  const renewEmbedding = Effect.fn("KnowledgeRepo.renewEmbedding")(function* (
    versionId: string,
    leaseToken: string,
    connectionRevision: string,
  ) {
    const rows = yield* db
      .update(knowledgeEmbeddingJobs)
      .set({
        leaseUntil: leaseFor(LEASE_SECONDS),
      })
      .where(
        and(
          eq(knowledgeEmbeddingJobs.versionId, versionId),
          eq(knowledgeEmbeddingJobs.leaseToken, leaseToken),
          eq(knowledgeEmbeddingJobs.connectionRevision, connectionRevision),
          eq(knowledgeEmbeddingJobs.status, "running"),
          sql`${knowledgeEmbeddingJobs.leaseUntil} > clock_timestamp()`,
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
                sql`${knowledgeEmbeddingJobs.leaseUntil} > clock_timestamp()`,
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
    delayMs?: number;
    countAttempt?: boolean;
  }) {
    const counted = input.countAttempt ?? true;
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const updated = yield* tx
            .update(knowledgeEmbeddingJobs)
            .set({
              status: !input.retryable
                ? "failed"
                : counted
                  ? sql`case when ${knowledgeEmbeddingJobs.attempts} >= ${MAX_ATTEMPTS} then 'failed' else 'queued' end`
                  : "queued",
              // The claim counted this attempt; a rate limit gives it back.
              ...(counted
                ? {}
                : { attempts: sql`greatest(${knowledgeEmbeddingJobs.attempts} - 1, 0)` }),
              notBefore: input.delayMs
                ? sql`now() + ${`${Math.round(input.delayMs)} milliseconds`}::interval`
                : null,
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
                sql`${knowledgeEmbeddingJobs.leaseUntil} > clock_timestamp()`,
              ),
            )
            .returning({ status: knowledgeEmbeddingJobs.status })
            .pipe(Effect.orDie);
          if (updated[0]?.status === "queued")
            yield* notifyOnCommit(tx, {
              scope: "internal",
              event: { type: "knowledge.work", stage: "embedding" },
            });
        }),
      )
      .pipe(Effect.orDie);
  });

  return {
    recoverExpiredJobs,
    claimExtraction,
    completeExtraction,
    renewExtractionLease,
    failExtraction,
    claimEmbedding,
    renewEmbedding,
    listChunksForEmbedding,
    completeEmbedding,
    failEmbedding,
  } satisfies Partial<KnowledgeRepo["Service"]>;
};
