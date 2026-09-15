import { Context, Effect, Layer, Schema } from "effect";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import {
  CreateDocumentInput,
  DOCUMENT_LIMITS,
  DocumentRejected,
  EditDocumentInput,
  ReplaceDocumentInput,
  SaveDocumentInput,
  ToggleDocumentTaskInput,
  type ConversationDocument,
  type DocumentNotAvailable,
  type EditDocumentResult,
  type ToggleDocumentTaskResult,
  type WriteDocumentResult,
} from "../schema.ts";
import { toggleTaskItem } from "../task-items.ts";
import { DocumentRepo } from "./document-repo.ts";

export type DocumentWriteGuard<E = never, R = never> = (tx: DbTx) => Effect.Effect<unknown, E, R>;
type DocumentError = DocumentNotAvailable | DocumentRejected;

const countOccurrences = (haystack: string, needle: string) => {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
};
const preview = (content: string) =>
  content.split("\n").slice(0, DOCUMENT_LIMITS.noMatchPreviewLines).join("\n");
const decode =
  <S extends Schema.Top>(schema: S, reason: string) =>
  (input: S["Type"]) =>
    Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new DocumentRejected({ reason })),
    );
const withinCap = (content: string) =>
  content.length > DOCUMENT_LIMITS.chars
    ? Effect.fail(
        new DocumentRejected({ reason: `document exceeds ${DOCUMENT_LIMITS.chars} characters` }),
      )
    : Effect.void;

export class DocumentService extends Context.Service<
  DocumentService,
  {
    get(userId: string, documentId: string): Effect.Effect<ConversationDocument | null>;
    list(userId: string, conversationId: string): Effect.Effect<ConversationDocument[]>;
    create<E = never, R = never>(
      userId: string,
      input: CreateDocumentInput,
      guard?: DocumentWriteGuard<E, R>,
    ): Effect.Effect<{ outcome: "created"; document: ConversationDocument }, DocumentError | E, R>;
    /**
     * Anchor-guarded patch: `old` must occur exactly once in the current
     * content, which is the conflict check. `expectedRevision` only flags a
     * stale read, so a person's tick elsewhere never blocks the model's edit.
     */
    edit<E = never, R = never>(
      userId: string,
      input: EditDocumentInput,
      guard?: DocumentWriteGuard<E, R>,
    ): Effect.Effect<EditDocumentResult, DocumentError | E, R>;
    replace<E = never, R = never>(
      userId: string,
      input: ReplaceDocumentInput,
      guard?: DocumentWriteGuard<E, R>,
    ): Effect.Effect<WriteDocumentResult, DocumentError | E, R>;
    /** The person's source editor: whole content under CAS. */
    writeUser(
      userId: string,
      input: SaveDocumentInput,
    ): Effect.Effect<WriteDocumentResult, DocumentError>;
    /** One task line by ordinal, patched server-side so it lands beside a model edit. */
    toggleTask(
      userId: string,
      input: ToggleDocumentTaskInput,
    ): Effect.Effect<ToggleDocumentTaskResult, DocumentError>;
  }
>()("chat/documents/DocumentService") {
  static readonly layer = Layer.effect(
    DocumentService,
    Effect.gen(function* () {
      const db = yield* Db;
      const documents = yield* DocumentRepo;
      const bus = yield* SyncBus;
      const documentChanged = (
        userId: string,
        document: Pick<ConversationDocument, "id" | "conversationId">,
      ) =>
        bus
          .publish(userId, {
            type: "document.changed",
            conversationId: document.conversationId,
            documentId: document.id,
          })
          .pipe(Effect.catchCause(() => Effect.logWarning("document invalidation failed")));
      const transaction = <A, E, R>(body: (tx: DbTx) => Effect.Effect<A, E, R>) =>
        db.transaction(body).pipe(Effect.catchTag("SqlError", Effect.die));

      const create = <E = never, R = never>(
        userId: string,
        input: CreateDocumentInput,
        guard?: DocumentWriteGuard<E, R>,
      ) =>
        Effect.gen(function* () {
          const parsed = yield* decode(CreateDocumentInput, "invalid document")(input);
          yield* withinCap(parsed.content);
          const document = yield* transaction((tx) =>
            Effect.gen(function* () {
              // Keep fence failures outside recoverable validation/conflict handling.
              if (guard) yield* guard(tx);
              yield* documents.lockConversation(tx, userId, parsed.conversationId);
              return yield* documents.create(tx, parsed.conversationId, {
                title: parsed.title,
                content: parsed.content,
                createdByMessageId: parsed.createdByMessageId ?? null,
                lastEditedBy: "model",
              });
            }),
          );
          yield* documentChanged(userId, document);
          return { outcome: "created" as const, document };
        });

      const edit = <E = never, R = never>(
        userId: string,
        input: EditDocumentInput,
        guard?: DocumentWriteGuard<E, R>,
      ) =>
        Effect.gen(function* () {
          const parsed = yield* decode(EditDocumentInput, "invalid document edit")(input);
          const result = yield* transaction((tx) =>
            Effect.gen(function* () {
              if (guard) yield* guard(tx);
              const document = yield* documents.lock(tx, userId, parsed.documentId);
              const staleRead =
                parsed.expectedRevision !== undefined &&
                parsed.expectedRevision !== document.revision;
              const count = countOccurrences(document.content, parsed.old);
              if (count === 0)
                return {
                  outcome: "no_match" as const,
                  document,
                  preview: preview(document.content),
                  staleRead,
                };
              if (count > 1) return { outcome: "ambiguous" as const, document, count, staleRead };
              const content = document.content.replace(parsed.old, () => parsed.new);
              if (content === document.content)
                return { outcome: "unchanged" as const, document, staleRead };
              yield* withinCap(content);
              return {
                outcome: "updated" as const,
                document: yield* documents.write(tx, document.id, {
                  content,
                  revision: document.revision + 1,
                  lastEditedBy: "model",
                }),
                staleRead,
              };
            }),
          );
          if (result.outcome === "updated") yield* documentChanged(userId, result.document);
          return result;
        });

      const writeWhole = <E = never, R = never>(
        userId: string,
        parsed: ReplaceDocumentInput,
        lastEditedBy: ConversationDocument["lastEditedBy"],
        guard?: DocumentWriteGuard<E, R>,
      ) =>
        Effect.gen(function* () {
          yield* withinCap(parsed.content);
          const result = yield* transaction((tx) =>
            Effect.gen(function* () {
              if (guard) yield* guard(tx);
              const document = yield* documents.lock(tx, userId, parsed.documentId);
              if (document.revision !== parsed.expectedRevision)
                return { outcome: "conflict" as const, document };
              if (document.content === parsed.content)
                return { outcome: "unchanged" as const, document };
              return {
                outcome: "updated" as const,
                document: yield* documents.write(tx, document.id, {
                  content: parsed.content,
                  revision: document.revision + 1,
                  lastEditedBy,
                }),
              };
            }),
          );
          if (result.outcome === "updated") yield* documentChanged(userId, result.document);
          return result;
        });

      const replace = <E = never, R = never>(
        userId: string,
        input: ReplaceDocumentInput,
        guard?: DocumentWriteGuard<E, R>,
      ) =>
        Effect.gen(function* () {
          const parsed = yield* decode(ReplaceDocumentInput, "invalid document replacement")(input);
          return yield* writeWhole(userId, parsed, "model", guard);
        });

      return DocumentService.of({
        get: documents.get,
        list: documents.listForConversation,
        create,
        edit,
        replace,
        writeUser: Effect.fn("DocumentService.writeUser")(function* (userId, input) {
          const parsed = yield* decode(SaveDocumentInput, "invalid document save")(input);
          return yield* writeWhole(userId, parsed, "user");
        }),
        toggleTask: Effect.fn("DocumentService.toggleTask")(function* (userId, input) {
          const parsed = yield* decode(ToggleDocumentTaskInput, "invalid task toggle")(input);
          const result = yield* transaction((tx) =>
            Effect.gen(function* () {
              const document = yield* documents.lock(tx, userId, parsed.documentId);
              if (
                parsed.expectedRevision !== undefined &&
                parsed.expectedRevision !== document.revision
              )
                return { outcome: "conflict" as const, document };
              const content = toggleTaskItem(document.content, parsed.ordinal, parsed.checked);
              if (content === null) return { outcome: "no_match" as const, document };
              if (content === document.content) return { outcome: "unchanged" as const, document };
              return {
                outcome: "updated" as const,
                document: yield* documents.write(tx, document.id, {
                  content,
                  revision: document.revision + 1,
                  lastEditedBy: "user",
                }),
              };
            }),
          );
          if (result.outcome === "updated") yield* documentChanged(userId, result.document);
          return result;
        }),
      });
    }),
  ).pipe(Layer.provide(DocumentRepo.layer));
}
