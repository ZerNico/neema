import { wakeOn } from "~/modules/sync/server/wakeup.ts";
import { Context, Duration, Effect, Layer, Stream } from "effect";
import { MAX_ATTACHMENT_BYTES } from "~/modules/attachments/constants.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import {
  DocumentParser,
  stripControlCharacters,
} from "~/modules/attachments/server/document-parser.ts";
import { AiGateway, ProviderUnreachable } from "~/modules/providers/server/gateway.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { KNOWLEDGE_LIMITS } from "../schema.ts";
import { chunkDocument } from "./chunking.ts";
import { EmbeddingSpace } from "./embedding-space.ts";
import { KnowledgeRepo } from "./repo.ts";

// Expired leases become claimable without a write or notification.
const RECOVERY_INTERVAL = Duration.seconds(30);
const FAILURE_BACKOFF = Duration.seconds(5);

const decoder = new TextDecoder("utf-8", { fatal: true });

const isTextual = (mediaType: string) =>
  mediaType.startsWith("text/") ||
  mediaType === "application/json" ||
  mediaType === "application/xml";

/**
 * Background extraction and embedding for knowledge documents.
 *
 * Uploading a file or saving a note returns as soon as the row exists; parsing
 * and embedding happen here. Work is claimed from the version and job rows
 * themselves with a lease, so a crash or a dev reload leaves nothing stranded
 * and nothing needs a queue server.
 *
 * The two stages are independent on purpose: text and chunks are the immutable
 * content of a version, while vectors are a replaceable derivative. Embeddings
 * can fail, be disabled, or be rebuilt into a different space without ever
 * making a document unreadable — lexical search and reads keep working.
 */
export class KnowledgeIndexer extends Context.Service<
  KnowledgeIndexer,
  {
    /** One independent recovery sweep, including when semantic search is disabled. */
    recoverExpiredJobs(): Effect.Effect<void>;
    /** Runs one extraction, if any is pending. Returns false when idle. */
    runExtraction(): Effect.Effect<boolean>;
    /** Runs one embedding job, if any is pending. Returns false when idle. */
    runEmbedding(): Effect.Effect<boolean>;
  }
>()("chat/knowledge/KnowledgeIndexer") {
  static readonly layer = Layer.effect(
    KnowledgeIndexer,
    Effect.gen(function* () {
      const repo = yield* KnowledgeRepo;
      const parser = yield* DocumentParser;
      const store = yield* BlobStore;
      const gateway = yield* AiGateway;
      const space = yield* EmbeddingSpace;
      const sync = yield* SyncBus;
      const changed = () =>
        sync
          .publishGlobal({ type: "knowledge.index.changed" })
          .pipe(
            Effect.catchCause(() =>
              Effect.logWarning("knowledge index changed but resource invalidation failed"),
            ),
          );

      const runExtraction = Effect.fn("KnowledgeIndexer.runExtraction")(function* () {
        const claim = yield* repo.claimExtraction();
        if (!claim) return false;
        yield* changed();
        const { version, storageKey, leaseToken } = claim;
        const fail = (error: string, retryable: boolean) =>
          repo.failExtraction({ versionId: version.id, leaseToken, error, retryable });

        const publish = (
          text: string,
          pageCount: number | null,
          parsedWith: string | null = null,
          skippedPages: ReadonlyArray<number> = [],
        ) =>
          Effect.gen(function* () {
            if (!text.trim()) {
              yield* fail("no readable text could be extracted", false);
              return;
            }
            if (text.length > KNOWLEDGE_LIMITS.maxExtractedChars) {
              yield* fail(
                "document exceeds the extraction limit; split it into smaller documents",
                false,
              );
              return;
            }
            const chunks = chunkDocument(text);
            if (chunks.length === 0 || chunks.length > KNOWLEDGE_LIMITS.maxChunksPerVersion) {
              yield* fail(
                "document exceeds the chunk limit; split it into smaller documents",
                false,
              );
              return;
            }
            // Pages without a text layer are recorded, not fatal: the rest of
            // the document is real content, and the gap is disclosed to
            // readers and to the model as incomplete coverage.
            yield* repo.completeExtraction({
              versionId: version.id,
              leaseToken,
              text,
              pageCount,
              truncated:
                skippedPages.length > 0
                  ? {
                      truncated: true,
                      reason: `${skippedPages.length === 1 ? "Page" : "Pages"} ${skippedPages.join(", ")} ${skippedPages.length === 1 ? "has" : "have"} no extractable text (probably scanned) and ${skippedPages.length === 1 ? "was" : "were"} skipped.`,
                    }
                  : { truncated: false, reason: null },
              chunks,
              parsedWith,
            });
          });

        if (version.kind === "note") {
          const content = stripControlCharacters(version.noteContent ?? "");
          if (content.length > KNOWLEDGE_LIMITS.maxNoteChars) {
            yield* fail("note exceeds the size limit; split it into smaller notes", false);
          } else {
            yield* publish(content, null);
          }
          return true;
        }

        if (!version.blobId || !version.mediaType) {
          yield* fail("the uploaded file is missing", false);
          return true;
        }

        if (!storageKey) {
          yield* fail("the stored file is no longer available", false);
          return true;
        }
        const bytes = yield* store
          .get(storageKey)
          .pipe(
            Effect.catchTag("BlobStoreError", () =>
              fail("could not read the stored file; try again", true).pipe(Effect.as(null)),
            ),
          );
        if (!bytes) return true;

        if (bytes.length > MAX_ATTACHMENT_BYTES) {
          yield* fail("file exceeds the 20 MiB upload limit", false);
          return true;
        }
        const mediaType = version.mediaType;
        let text: string;
        let pageCount: number | null = null;
        let parsedWith: string | null = null;
        let skippedPages: ReadonlyArray<number> = [];

        if (mediaType === "application/pdf") {
          const parsed = yield* parser
            .parsePdf({
              bytes,
              fileName: version.fileName ?? "document.pdf",
              requireComplete: true,
              limits: {
                maxChars: KNOWLEDGE_LIMITS.maxExtractedChars,
                maxPages: KNOWLEDGE_LIMITS.maxPages,
              },
            })
            .pipe(
              Effect.timeout(Duration.seconds(60)),
              Effect.catchTag("TimeoutError", () =>
                fail("document extraction timed out; split it into smaller documents", false).pipe(
                  Effect.as(null),
                ),
              ),
              Effect.catchTag("DocumentParseError", (error) =>
                // A scan with no text layer will not parse on the next attempt
                // either; saying so is more useful than retrying three times.
                fail(error.reason, false).pipe(Effect.as(null)),
              ),
            );
          if (!parsed) return true;
          text = parsed.text;
          parsedWith = parsed.parsedWith;
          if (parsed.truncated) {
            yield* fail(
              "document exceeds the extraction limit; split it into smaller documents",
              false,
            );
            return true;
          }
          pageCount = (text.match(/^\[page \d+\]$/gm) ?? []).length || null;
          skippedPages = parsed.skippedPages ?? [];
        } else if (isTextual(mediaType)) {
          parsedWith = "utf8";
          try {
            text = stripControlCharacters(decoder.decode(bytes));
          } catch {
            yield* fail("text is not valid UTF-8; save it as UTF-8 and upload again", false);
            return true;
          }
        } else {
          yield* fail(`${mediaType} files cannot be indexed yet`, false);
          return true;
        }

        yield* publish(text, pageCount, parsedWith, skippedPages);
        return true;
      });

      const runEmbedding = Effect.fn("KnowledgeIndexer.runEmbedding")(function* () {
        const target = yield* space.current();
        if (!target) return false;
        const claim = yield* repo.claimEmbedding(target.spaceId, target.connectionRevision);
        if (!claim) return false;
        yield* changed();
        const { versionId, leaseToken } = claim;

        const chunks = yield* repo.listChunksForEmbedding(versionId);
        if (chunks.length === 0) {
          yield* repo.failEmbedding({
            versionId,
            leaseToken,
            error: "document has no extracted chunks; replace the document to index it",
            retryable: false,
          });
          return true;
        }

        const vectors: { chunkId: string; embedding: ReadonlyArray<number> }[] = [];
        for (let index = 0; index < chunks.length;) {
          const current = yield* space.current();
          if (
            !current ||
            current.connectionRevision !== target.connectionRevision ||
            current.spaceId !== target.spaceId ||
            !(yield* repo.renewEmbedding(versionId, leaseToken, target.connectionRevision))
          )
            return true;
          const batch: (typeof chunks)[number][] = [];
          const inputs: string[] = [];
          let chars = 0;
          while (index < chunks.length && batch.length < KNOWLEDGE_LIMITS.embeddingBatchSize) {
            const chunk = chunks[index]!;
            // Include the title and breadcrumb, but count them in the batch cap.
            const text = [chunk.title, chunk.headingPath, chunk.content].filter(Boolean).join("\n");
            if (batch.length > 0 && chars + text.length > KNOWLEDGE_LIMITS.embeddingMaxBatchChars)
              break;
            batch.push(chunk);
            inputs.push(text);
            chars += text.length;
            index += 1;
          }
          const result = yield* gateway
            .embed({
              modelId: target.modelId,
              attribution: { userId: claim.ownerUserId, kind: "embedding_document" },
              inputs,
              expectedDimensions: target.dimensions,
              expectedConnection: target.connection,
              beforeDispatch: () =>
                Effect.gen(function* () {
                  const approved = yield* space.current();
                  if (
                    !approved ||
                    approved.spaceId !== target.spaceId ||
                    approved.connectionRevision !== target.connectionRevision ||
                    !(yield* repo.renewEmbedding(versionId, leaseToken, target.connectionRevision))
                  )
                    return yield* new ProviderUnreachable({
                      providerId: target.connection.providerId,
                      message: "embedding work is no longer current; retry indexing",
                      diagnostic: { kind: "InvalidRequestError" },
                    });
                }),
            })
            .pipe(Effect.result);
          if (result._tag === "Failure") {
            // Provider trouble is transient far more often than not; the
            // attempt counter is what stops it from retrying forever.
            yield* repo.failEmbedding({
              versionId,
              leaseToken,
              error: describeFailure(result.failure),
              retryable:
                result.failure._tag === "ProviderUnreachable" &&
                result.failure.diagnostic?.kind !== "InvalidRequestError",
            });
            return true;
          }
          for (const [position, embedding] of result.success.embeddings.entries()) {
            vectors.push({ chunkId: batch[position]!.id, embedding });
          }
        }

        if (!(yield* repo.renewEmbedding(versionId, leaseToken, target.connectionRevision)))
          return true;
        yield* repo.completeEmbedding({
          versionId,
          leaseToken,
          spaceId: target.spaceId,
          connectionRevision: target.connectionRevision,
          dimensions: target.dimensions,
          vectors,
        });
        return true;
      });

      const settled = (worked: boolean) => (worked ? changed() : Effect.void);
      return KnowledgeIndexer.of({
        recoverExpiredJobs: () =>
          repo
            .recoverExpiredJobs()
            .pipe(Effect.flatMap((count) => (count > 0 ? changed() : Effect.void))),
        runExtraction: () => runExtraction().pipe(Effect.tap(settled)),
        runEmbedding: () => runEmbedding().pipe(Effect.tap(settled)),
      });
    }),
  );
  static readonly workers = Layer.effectDiscard(
    Effect.gen(function* () {
      const indexer = yield* KnowledgeIndexer;
      const sync = yield* SyncBus;
      const loop = (stage: "extraction" | "embedding", step: Effect.Effect<boolean>) =>
        Effect.gen(function* () {
          const wake = yield* wakeOn(
            sync.signals.pipe(
              Stream.filter(
                (event) =>
                  event.type === "ready" ||
                  (event.type === "knowledge.work" && event.stage === stage),
              ),
            ),
          );
          return yield* Effect.gen(function* () {
            yield* wake.pipe(Effect.timeoutOption(RECOVERY_INTERVAL));
            // A failed step retries after backoff, not after another idle interval.
            while (
              yield* step.pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("knowledge indexing step failed", cause).pipe(
                    Effect.andThen(Effect.sleep(FAILURE_BACKOFF)),
                    Effect.as(true),
                  ),
                ),
              )
            ) {
              /* Drain before waiting again. */
            }
          }).pipe(Effect.forever);
        });
      yield* indexer.recoverExpiredJobs().pipe(
        Effect.catchCause((cause) => Effect.logError("knowledge recovery failed", cause)),
        Effect.andThen(Effect.sleep(RECOVERY_INTERVAL)),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* loop("extraction", indexer.runExtraction()).pipe(Effect.forkScoped);
      for (let worker = 0; worker < KNOWLEDGE_LIMITS.embeddingConcurrency; worker++)
        yield* loop("embedding", indexer.runEmbedding()).pipe(Effect.forkScoped);
    }),
  );
}

/** Provider failures are already sanitized; keep the tag when there is no text. */
const describeFailure = (error: { _tag: string; message?: string }): string =>
  error.message && error.message.length > 0 ? error.message : error._tag;
