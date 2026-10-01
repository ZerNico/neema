import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { MAX_ATTACHMENT_BYTES } from "~/modules/attachments/constants.ts";
import type { KnowledgeNotAvailable, KnowledgeRejected } from "../errors.ts";
import {
  AddKnowledgeNoteInput,
  CollectionIdInput,
  CollectionIdentityInput,
  DisableEmbeddingInput,
  EmbeddingConfigurationChange,
  KnowledgeDocumentIdInput,
  ReadKnowledgeDocumentInput,
  ReplaceKnowledgeNoteInput,
  UpdateCollectionInput,
} from "../schema.ts";
import { EmbeddingSpace } from "./embedding-space.ts";
import { KnowledgeService } from "./service.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { refuseUpload } from "~/modules/attachments/server/upload-refusal.ts";

const standard = Schema.toStandardSchemaV1;
const publicResult = <A, R>(
  effect: Effect.Effect<A, KnowledgeNotAvailable | KnowledgeRejected, R>,
) =>
  effect.pipe(
    Effect.catchTag("KnowledgeNotAvailable", () =>
      Effect.die(new Response("Not found", { status: 404 })),
    ),
    Effect.catchTag("KnowledgeRejected", (error) =>
      Effect.die(new Response(error.reason, { status: 400 })),
    ),
  );

export const listKnowledgeCollections = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(KnowledgeService.use((service) => service.list(context.session.user.id))),
  );

export const getKnowledgeCollection = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(CollectionIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) =>
          service.detail(context.session.user.id, data.collectionId),
        ),
      ),
    ),
  );

export const createKnowledgeCollection = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(CollectionIdentityInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) => service.create(context.session.user.id, data)),
      ),
    ),
  );

export const updateKnowledgeCollection = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(UpdateCollectionInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) => service.update(context.session.user.id, data)),
      ),
    ),
  );

export const deleteKnowledgeCollection = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(CollectionIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) =>
          service.remove(context.session.user.id, data.collectionId),
        ),
      ),
    ),
  );

export const addKnowledgeNote = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(AddKnowledgeNoteInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) => service.addNote(context.session.user.id, data)),
      ),
    ),
  );

export const deleteKnowledgeDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(KnowledgeDocumentIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) =>
          service.removeDocument(context.session.user.id, data.documentId),
        ),
      ),
    ),
  );

export const rebuildKnowledgeIndex = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(CollectionIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) =>
          service.rebuildIndex(context.session.user.id, data.collectionId),
        ),
      ),
    ),
  );

export const readKnowledgeDocument = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ReadKnowledgeDocumentInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(KnowledgeService.use((service) => service.read(context.session.user.id, data))),
    ),
  );

export const replaceKnowledgeNote = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ReplaceKnowledgeNoteInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) => service.replaceNote(context.session.user.id, data)),
      ),
    ),
  );

export const uploadKnowledgeDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator((data: FormData) => data)
  .handler(async ({ data, context }) => {
    const file = data.get("file");
    if (!(file instanceof File)) throw new Response("Expected a file", { status: 400 });
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Response("File is too large", { status: 413 });
    const collectionId = data.get("collectionId");
    const documentId = data.get("documentId");
    const title = data.get("title");
    if (
      typeof collectionId !== "string" ||
      !collectionId ||
      collectionId.length > 128 ||
      typeof title !== "string" ||
      title.length > 120 ||
      (documentId !== null &&
        (typeof documentId !== "string" || !documentId || documentId.length > 128))
    )
      throw new Response("Invalid document fields", { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    return runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) =>
          service.upload(context.session.user.id, {
            collectionId,
            ...(documentId === null ? {} : { documentId }),
            title,
            fileName: file.name,
            declaredMediaType: file.type,
            bytes,
          }),
        ).pipe(Effect.catchTag("AttachmentRejected", refuseUpload)),
      ),
    );
  });

export const retryKnowledgeDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(KnowledgeDocumentIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) =>
          service.retryDocument(context.session.user.id, data.documentId),
        ),
      ),
    ),
  );

// ---------------------------------------------------------- admin: embeddings

/**
 * The semantic-search configuration and the models an admin may choose from.
 * Only enabled, instance-usable embedding models are eligible: a
 * group-restricted model must not become an instance service through the
 * back door (see `readConnection`).
 */
export const getEmbeddingConfiguration = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(({ context }) =>
    runtime.runPromise(
      publicResult(
        Effect.gen(function* () {
          const space = yield* EmbeddingSpace;
          const providers = yield* ProviderRepo;
          const status = yield* space.detail(context.session.user.id);
          const providerRows = yield* providers.listProviders();
          const providerName = new Map(providerRows.map((row) => [row.id, row.name]));
          const models = (yield* providers.listModels({ enabledOnly: true }))
            .filter(
              (model) =>
                model.type === "embedding" &&
                model.access === "public" &&
                providerRows.some((row) => row.id === model.providerId && row.enabled),
            )
            .map((model) => ({
              id: model.id,
              displayName: model.displayName,
              providerName: providerName.get(model.providerId) ?? "",
              dimensions: model.embeddingDimensions,
            }));
          return { ...status, models };
        }),
      ),
    ),
  );

export const rebuildAllKnowledgeIndexes = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(({ context }) =>
    runtime.runPromise(
      publicResult(
        KnowledgeService.use((service) => service.rebuildAllIndexes(context.session.user.id)),
      ),
    ),
  );

export const configureEmbeddings = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(EmbeddingConfigurationChange))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(EmbeddingSpace.use((space) => space.configure(context.session.user.id, data))),
    ),
  );

export const disableEmbeddings = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(DisableEmbeddingInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      publicResult(EmbeddingSpace.use((space) => space.disable(context.session.user.id, data))),
    ),
  );
