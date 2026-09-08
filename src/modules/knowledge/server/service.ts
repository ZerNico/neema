import { Context, Effect, Layer } from "effect";
import type { AttachmentRejected } from "~/modules/attachments/errors.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { KnowledgeNotAvailable, KnowledgeRejected } from "../errors.ts";
import { KNOWLEDGE_LIMITS, type CollectionSummary, type KnowledgeDocument } from "../schema.ts";
import { pipelineFingerprint } from "./chunking.ts";
import { textEnd } from "./text-range.ts";
import {
  DocumentParser,
  stripControlCharacters,
} from "~/modules/attachments/server/document-parser.ts";
import { EmbeddingSpace } from "./embedding-space.ts";
import {
  KnowledgeRepo,
  type ManifestEntry,
  type VersionBody,
  type VersionBodyReference,
} from "./repo.ts";

export interface DocumentReference {
  collectionId: string;
  documentId: string;
  versionId: string;
}
export interface DocumentExcerpt extends DocumentReference {
  title: string;
  content: string;
  startOffset: number;
  endOffset: number;
  totalChars: number;
  nextOffset: number | null;
}

const MAX_READ_CHARS = 16_000;

/** Actor ids are supplied by authenticated server handlers, never request data. */
export class KnowledgeService extends Context.Service<
  KnowledgeService,
  {
    list(userId: string): Effect.Effect<ReadonlyArray<CollectionSummary>>;
    detail(
      userId: string,
      collectionId: string,
    ): Effect.Effect<
      { collection: CollectionSummary; documents: ReadonlyArray<KnowledgeDocument> },
      KnowledgeNotAvailable
    >;
    create(
      userId: string,
      input: { name: string; description: string },
    ): Effect.Effect<string, KnowledgeRejected>;
    update(
      userId: string,
      input: { collectionId: string; name: string; description: string },
    ): Effect.Effect<void, KnowledgeNotAvailable | KnowledgeRejected>;
    remove(userId: string, collectionId: string): Effect.Effect<void, KnowledgeNotAvailable>;
    addNote(
      userId: string,
      input: { collectionId: string; title: string; content: string },
    ): Effect.Effect<
      { documentId: string; versionId: string },
      KnowledgeNotAvailable | KnowledgeRejected
    >;
    upload(
      userId: string,
      input: {
        collectionId: string;
        documentId?: string;
        title: string;
        fileName: string;
        declaredMediaType: string;
        bytes: Uint8Array;
      },
    ): Effect.Effect<
      { documentId: string; versionId: string },
      KnowledgeNotAvailable | KnowledgeRejected | AttachmentRejected
    >;
    replaceNote(
      userId: string,
      input: { collectionId: string; documentId: string; title: string; content: string },
    ): Effect.Effect<
      { documentId: string; versionId: string },
      KnowledgeNotAvailable | KnowledgeRejected
    >;
    retryDocument(
      userId: string,
      documentId: string,
    ): Effect.Effect<void, KnowledgeNotAvailable | KnowledgeRejected>;
    removeDocument(userId: string, documentId: string): Effect.Effect<void, KnowledgeNotAvailable>;
    reindex(
      userId: string,
      collectionId: string,
    ): Effect.Effect<number, KnowledgeNotAvailable | KnowledgeRejected>;
    /**
     * Re-extracts documents whose text predates the current parser/chunker.
     * Old versions are retained, so existing citations keep resolving.
     */
    rebuildContent(
      userId: string,
      collectionId: string,
    ): Effect.Effect<number, KnowledgeNotAvailable>;
    /**
     * The one owner-facing repair: re-extract stale text, then re-embed every
     * published version that is not indexed for the current model. Documents
     * that are already current are left alone, so it is safe to run whenever
     * something looks off. Returns what was queued for each half.
     */
    rebuildIndex(
      userId: string,
      collectionId: string,
    ): Effect.Effect<{ reextracted: number; reembedded: number }, KnowledgeNotAvailable>;
    /**
     * Admin: `rebuildIndex` for every collection on the instance, each run as
     * its owner. Only stale work is queued, so this is the safe "I changed the
     * embedding model" button rather than a bulk re-embed of everything.
     */
    rebuildAllIndexes(
      userId: string,
    ): Effect.Effect<
      { collections: number; reextracted: number; reembedded: number },
      KnowledgeRejected
    >;
    manifest(
      userId: string,
      collectionIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<ManifestEntry>, KnowledgeNotAvailable | KnowledgeRejected>;
    read(
      userId: string,
      input: DocumentReference & { startOffset: number; maxChars: number },
    ): Effect.Effect<DocumentExcerpt, KnowledgeNotAvailable | KnowledgeRejected>;
    /** Internal full-context load after metadata admission; never a tool range loop. */
    readBodies(
      userId: string,
      references: ReadonlyArray<VersionBodyReference>,
    ): Effect.Effect<ReadonlyArray<VersionBody>, KnowledgeNotAvailable>;
    download(
      userId: string,
      reference: DocumentReference,
    ): Effect.Effect<
      { fileName: string; mediaType: string; bytes: Uint8Array },
      KnowledgeNotAvailable
    >;
  }
>()("chat/knowledge/KnowledgeService") {
  static readonly layer = Layer.effect(
    KnowledgeService,
    Effect.gen(function* () {
      const repo = yield* KnowledgeRepo;
      const space = yield* EmbeddingSpace;
      const parser = yield* DocumentParser;
      const store = yield* BlobStore;
      const bus = yield* SyncBus;
      const attachments = yield* AttachmentService;
      const attachmentRepo = yield* AttachmentRepo;
      const changed = () =>
        bus
          .publishGlobal({ type: "resources.changed" })
          .pipe(
            Effect.catchCause(() => Effect.logWarning("knowledge resource invalidation failed")),
          );
      const available = Effect.fn(function* (
        userId: string,
        collectionId: string,
        ownerOnly = false,
      ) {
        const collection = yield* repo.getCollection(userId, collectionId);
        if (!collection || (ownerOnly && !collection.canEdit))
          return yield* new KnowledgeNotAvailable({ resourceId: collectionId });
        return collection;
      });
      const name = (value: string) =>
        value.trim().length > 0 && value.trim().length <= KNOWLEDGE_LIMITS.maxNameLength;
      const validateIdentity = (input: { name: string; description: string }) =>
        name(input.name) && input.description.length <= KNOWLEDGE_LIMITS.maxDescriptionLength
          ? Effect.void
          : Effect.fail(
              new KnowledgeRejected({
                reason:
                  "enter a name of 1–120 characters and a description of at most 500 characters",
              }),
            );
      const saveNote = Effect.fn(function* (
        userId: string,
        input: { collectionId: string; documentId?: string; title: string; content: string },
      ) {
        yield* available(userId, input.collectionId, true);
        // Postgres refuses NUL in text columns, and a pasted PDF extraction can
        // carry it. Strip here so the stored note (and its identical-save
        // dedup) never sees a byte the database cannot hold.
        input = { ...input, content: stripControlCharacters(input.content) };
        if (
          !name(input.title) ||
          !input.content.trim() ||
          input.content.length > KNOWLEDGE_LIMITS.maxNoteChars
        )
          return yield* new KnowledgeRejected({
            reason:
              "enter a title of 1–120 characters and a nonempty note of at most 200,000 characters",
          });
        const normalized = { ...input, title: input.title.trim() };
        const document = input.documentId
          ? yield* repo.replaceNoteDocument(userId, { ...normalized, documentId: input.documentId })
          : yield* repo.addNoteDocument(userId, normalized);
        if (!document) {
          if (input.documentId)
            return yield* new KnowledgeNotAvailable({ resourceId: input.documentId });
          return yield* new KnowledgeRejected({
            reason: "document could not be added; reload and check the collection limit",
          });
        }
        yield* changed();
        return document;
      });

      const rebuildContentFor = Effect.fn("KnowledgeService.rebuildContent")(function* (
        userId: string,
        collectionId: string,
      ) {
        yield* available(userId, collectionId, true);
        const backend = yield* parser.availability();
        return yield* repo.rebuildCollectionContent(
          userId,
          collectionId,
          [
            pipelineFingerprint(null),
            pipelineFingerprint("utf8"),
            ...(backend.kind ? [pipelineFingerprint(backend.kind)] : []),
          ],
          backend.enabled && backend.kind === "local",
        );
      });

      const rebuildIndexFor = Effect.fn("KnowledgeService.rebuildIndex")(function* (
        userId: string,
        collectionId: string,
      ) {
        const reextracted = yield* rebuildContentFor(userId, collectionId);
        // Re-extracted versions embed on publication; only the rest need a job.
        // Without an approved model there is nothing to embed, and that is not
        // an error the owner can act on here.
        const reembedded = (yield* space.current())
          ? yield* repo.reindexCollection(userId, collectionId, { staleOnly: true })
          : 0;
        if (reextracted > 0 || reembedded > 0) yield* changed();
        return { reextracted, reembedded };
      });

      return KnowledgeService.of({
        list: repo.listCollections,
        detail: Effect.fn(function* (userId, collectionId) {
          const collection = yield* available(userId, collectionId);
          const target = yield* space.current();
          const documents = yield* repo.listDocuments(userId, collectionId, target);
          yield* available(userId, collectionId);
          return { collection, documents };
        }),
        create: Effect.fn(function* (userId, input) {
          yield* validateIdentity(input);
          const id = yield* repo.createCollection(userId, {
            name: input.name.trim(),
            description: input.description.trim(),
          });
          yield* changed();
          return id;
        }),
        update: Effect.fn(function* (userId, input) {
          yield* available(userId, input.collectionId, true);
          yield* validateIdentity(input);
          if (
            !(yield* repo.updateCollection(userId, input.collectionId, {
              name: input.name.trim(),
              description: input.description.trim(),
            }))
          )
            return yield* new KnowledgeNotAvailable({ resourceId: input.collectionId });
          yield* changed();
        }),
        remove: Effect.fn(function* (userId, collectionId) {
          yield* available(userId, collectionId, true);
          yield* attachments.deleteBlobs(yield* repo.deleteCollection(userId, collectionId));
          yield* changed();
        }),
        upload: Effect.fn(function* (userId, input) {
          yield* available(userId, input.collectionId, true);
          if (!name(input.title))
            return yield* new KnowledgeRejected({ reason: "enter a title of 1–120 characters" });
          if (input.documentId) {
            const document = yield* repo.documentCollection(userId, input.documentId);
            if (!document?.canEdit || document.collectionId !== input.collectionId)
              return yield* new KnowledgeNotAvailable({ resourceId: input.documentId });
          }
          const upload = yield* attachments.upload({
            userId,
            fileName: input.fileName,
            declaredMediaType: input.declaredMediaType,
            bytes: input.bytes,
            allowedKinds: ["pdf", "text"],
          });
          // The temporary upload holds the blob until the collection reference
          // commits. Cleanup removes only that temporary reference, even on failure.
          return yield* Effect.gen(function* () {
            const stored = yield* attachmentRepo.findForAccess(upload.id);
            if (!stored || stored.attachment.userId !== userId)
              return yield* new KnowledgeNotAvailable({ resourceId: input.collectionId });
            const file = {
              collectionId: input.collectionId,
              title: input.title.trim(),
              blobId: stored.attachment.blobId,
              fileName: stored.attachment.fileName,
              mediaType: stored.attachment.mediaType,
              byteSize: stored.attachment.size,
            };
            const document = input.documentId
              ? yield* repo.replaceFileDocument(userId, { ...file, documentId: input.documentId })
              : yield* repo.addFileDocument(userId, file);
            if (!document)
              return yield* new KnowledgeRejected({
                reason: "document could not be added; reload and check the collection limit",
              });
            yield* changed();
            return document;
          }).pipe(
            Effect.ensuring(
              attachments.remove({ userId, attachmentId: upload.id }).pipe(Effect.orDie),
            ),
          );
        }),
        addNote: saveNote,
        replaceNote: saveNote,
        retryDocument: Effect.fn(function* (userId, documentId) {
          const collection = yield* repo.documentCollection(userId, documentId);
          if (!collection?.canEdit)
            return yield* new KnowledgeNotAvailable({ resourceId: documentId });
          if (!(yield* repo.retryDocument(userId, documentId)))
            return yield* new KnowledgeRejected({
              reason: "only a failed document extraction can be retried",
            });
          yield* changed();
        }),
        removeDocument: Effect.fn(function* (userId, documentId) {
          const collection = yield* repo.documentCollection(userId, documentId);
          if (!collection?.canEdit)
            return yield* new KnowledgeNotAvailable({ resourceId: documentId });
          yield* attachments.deleteBlobs(yield* repo.deleteDocument(userId, documentId));
          yield* changed();
        }),
        rebuildContent: Effect.fn(function* (userId, collectionId) {
          const queued = yield* rebuildContentFor(userId, collectionId);
          if (queued > 0) yield* changed();
          return queued;
        }),
        rebuildIndex: (userId, collectionId) => rebuildIndexFor(userId, collectionId),
        rebuildAllIndexes: Effect.fn(function* (userId) {
          if (!(yield* repo.isAdmin(userId)))
            return yield* new KnowledgeRejected({ reason: "only admins can rebuild every index" });
          if (!(yield* space.current()))
            return yield* new KnowledgeRejected({
              reason: "semantic search needs an approved, enabled embedding connection",
            });
          const totals = { collections: 0, reextracted: 0, reembedded: 0 };
          for (const collection of yield* repo.listAllCollectionIds()) {
            // Run as the owner: the same authorization and locking as a manual
            // rebuild, one collection at a time, never a cross-user transaction.
            const result = yield* rebuildIndexFor(collection.userId, collection.id).pipe(
              Effect.catchTag("KnowledgeNotAvailable", () =>
                Effect.succeed({ reextracted: 0, reembedded: 0 }),
              ),
            );
            totals.collections += 1;
            totals.reextracted += result.reextracted;
            totals.reembedded += result.reembedded;
          }
          return totals;
        }),
        reindex: Effect.fn(function* (userId, collectionId) {
          yield* available(userId, collectionId, true);
          if (!(yield* space.current()))
            return yield* new KnowledgeRejected({
              reason: "semantic search needs an approved, enabled embedding connection",
            });
          const count = yield* repo.reindexCollection(userId, collectionId);
          yield* changed();
          return count;
        }),
        manifest: Effect.fn(function* (userId, collectionIds) {
          const ids = [...new Set(collectionIds)];
          if (ids.length > KNOWLEDGE_LIMITS.maxCollectionsPerSelection)
            return yield* new KnowledgeRejected({
              reason: "select at most five knowledge collections",
            });
          return yield* repo.resolveManifest(userId, ids);
        }),
        read: Effect.fn(function* (userId, input) {
          if (
            !Number.isInteger(input.startOffset) ||
            input.startOffset < 0 ||
            !Number.isInteger(input.maxChars) ||
            input.maxChars < 1 ||
            input.maxChars > MAX_READ_CHARS
          )
            return yield* new KnowledgeRejected({ reason: "invalid document range" });
          const version = yield* repo.readVersionForAccess(userId, input);
          if (!version || version.status !== "ready" || version.charCount === null)
            return yield* new KnowledgeNotAvailable({ resourceId: input.versionId });
          if (input.startOffset > version.charCount)
            return yield* new KnowledgeRejected({ reason: "invalid document range" });
          const requestedEnd = Math.min(version.charCount, input.startOffset + input.maxChars);
          const from = Math.max(0, input.startOffset - 1);
          const range = yield* repo.readVersionRange(
            input.versionId,
            from,
            Math.min(version.charCount, requestedEnd + 1),
          );
          if (range === null || !(yield* repo.readVersionForAccess(userId, input)))
            return yield* new KnowledgeNotAvailable({ resourceId: input.versionId });
          const start = input.startOffset - from;
          if (textEnd(range, start) !== start)
            return yield* new KnowledgeRejected({
              reason: "startOffset splits a Unicode character",
            });
          const end = textEnd(range, requestedEnd - from);
          if (end === start && input.startOffset < version.charCount)
            return yield* new KnowledgeRejected({
              reason: "maxChars must fit the next Unicode character",
            });
          const content = range.slice(start, end);
          const endOffset = from + end;
          return {
            collectionId: input.collectionId,
            documentId: input.documentId,
            versionId: input.versionId,
            title: version.title,
            content,
            startOffset: input.startOffset,
            endOffset,
            totalChars: version.charCount,
            nextOffset: endOffset < version.charCount ? endOffset : null,
          };
        }),
        readBodies: Effect.fn(function* (userId, references) {
          const bodies = yield* repo.readVersionBodiesForAccess(userId, references);
          const byId = new Map(bodies.map((body) => [body.versionId, body]));
          const result: VersionBody[] = [];
          for (const reference of references) {
            const body = byId.get(reference.versionId);
            if (
              !body ||
              body.collectionId !== reference.collectionId ||
              body.documentId !== reference.documentId ||
              body.text.length !== reference.charCount
            )
              return yield* new KnowledgeNotAvailable({ resourceId: reference.versionId });
            result.push(body);
          }
          yield* repo.authorizeVersions(
            userId,
            references.map((reference) => reference.versionId),
          );
          return result;
        }),
        download: Effect.fn(function* (userId, reference) {
          const version = yield* repo.readVersionForAccess(userId, reference);
          if (!version?.storageKey || !version.fileName || !version.mediaType)
            return yield* new KnowledgeNotAvailable({ resourceId: reference.versionId });
          const bytes = yield* store
            .get(version.storageKey)
            .pipe(
              Effect.catchTag("BlobStoreError", () =>
                Effect.fail(new KnowledgeNotAvailable({ resourceId: reference.versionId })),
              ),
            );
          // Revoke/delete while storage was being read must not serve new bytes.
          if (!(yield* repo.readVersionForAccess(userId, reference)))
            return yield* new KnowledgeNotAvailable({ resourceId: reference.versionId });
          return { fileName: version.fileName, mediaType: version.mediaType, bytes };
        }),
      });
    }),
  );
}
