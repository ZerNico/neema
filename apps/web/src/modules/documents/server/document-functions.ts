import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import {
  ConversationIdInput,
  DocumentIdInput,
  SaveDocumentInput,
  ToggleDocumentTaskInput,
  type DocumentNotAvailable,
  type DocumentRejected,
} from "../schema.ts";
import { DocumentService } from "./document-service.ts";

// Unexpected failures (driver errors can carry SQL or the content being
// written) are logged and replaced by `reportUnexpectedFailures`.
const publicResult = <A, R>(effect: Effect.Effect<A, DocumentNotAvailable | DocumentRejected, R>) =>
  effect.pipe(
    Effect.catchTag("DocumentNotAvailable", () =>
      Effect.die(new Response("Not found", { status: 404 })),
    ),
    Effect.catchTag("DocumentRejected", (error) =>
      Effect.die(new Response(error.reason, { status: 400 })),
    ),
  );
export const getDocument = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DocumentIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.get(context.session.user.id, data.documentId),
        ),
      ),
    ),
  );
export const listDocuments = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ConversationIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.list(context.session.user.id, data.conversationId),
        ),
      ),
    ),
  );
export const saveDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SaveDocumentInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.writeUser(context.session.user.id, data),
        ),
      ),
    ),
  );
export const toggleDocumentTask = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ToggleDocumentTaskInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.toggleTask(context.session.user.id, data),
        ),
      ),
    ),
  );
