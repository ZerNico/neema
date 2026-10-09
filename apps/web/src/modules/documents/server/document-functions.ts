import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import {
  CommentInput,
  ConversationIdInput,
  CreateProjectDocumentInput,
  DeleteCommentInput,
  DocumentIdInput,
  ProjectDocumentsInput,
  PushDocumentInput,
  ResolveThreadInput,
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
          service.list(context.session.user.id, { conversationId: data.conversationId }),
        ),
      ),
    ),
  );
/** A person's editor sends step batches and cursor state here; the live stream carries them out. */
export const pushDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PushDocumentInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) => service.push(context.session.user.id, data)),
      ),
    ),
  );

export const listProjectDocuments = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ProjectDocumentsInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.list(context.session.user.id, { projectId: data.projectId }),
        ),
      ),
    ),
  );
/** A person starting a blank document in a project; the model has its own tool. */
export const createProjectDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(CreateProjectDocumentInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.create(context.session.user.id, {
            projectId: data.projectId,
            title: data.title,
            content: "",
            by: "user",
          }),
        ).pipe(Effect.map((result) => result.document)),
      ),
    ),
  );
export const deleteProjectDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DocumentIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.remove(context.session.user.id, data.documentId),
        ),
      ),
    ),
  );

export const commentOnDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(CommentInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.comment(context.session.user.id, data),
        ),
      ),
    ),
  );
export const resolveDocumentThread = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ResolveThreadInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.resolveThread(context.session.user.id, data),
        ),
      ),
    ),
  );
export const deleteDocumentComment = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DeleteCommentInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(DocumentService, (service) =>
          service.deleteComment(context.session.user.id, data),
        ),
      ),
    ),
  );
