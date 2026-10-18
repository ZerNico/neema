import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { refusal } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  CommentInput,
  CreateProjectDocumentInput,
  DOCUMENT_LIMITS,
  DeleteCommentInput,
  DocumentIdInput,
  DocumentImageInput,
  DocumentVersionInput,
  ProjectDocumentsInput,
  PushDocumentInput,
  RenameDocumentInput,
  ResolveThreadInput,
} from "../schema.ts";
import { DocumentService } from "./document-service.ts";
import { createFromWord } from "./create-from-word.ts";
import { WORD_LIMITS } from "~/modules/word/limits.ts";

export const getDocument = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DocumentIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.get(context.session.user.id, data.documentId),
      ),
    ),
  );
/** A text document's versions, newest first, for someone who may edit it. */
export const getDocumentVersions = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DocumentIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.versions(context.session.user.id, data.documentId),
      ),
    ),
  );
/** The document as it was at one of its versions, as tree JSON text; null when no longer kept. */
export const getDocumentVersion = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DocumentVersionInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.versionAt(context.session.user.id, data.documentId, data.revision),
      ),
    ),
  );
/** A person's editor sends step batches and cursor state here; the live stream carries them out. */
export const pushDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PushDocumentInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) => service.push(context.session.user.id, data)),
    ),
  );

export const listProjectDocuments = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ProjectDocumentsInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.list(context.session.user.id, { projectId: data.projectId }),
      ),
    ),
  );
/** A person starting a blank document in a project; the model has its own tool. */
export const createProjectDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(CreateProjectDocumentInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.create(context.session.user.id, {
          projectId: data.projectId,
          title: data.title,
          content: "",
          by: "user",
        }),
      ).pipe(Effect.map((result) => result.document)),
    ),
  );
/**
 * A project document started from a Word file: multipart, since the file is
 * bytes. Answers what the file held that a document cannot, to show the person.
 */
export const createProjectDocumentFromWord = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator((data: FormData) => data)
  .handler(async ({ context, data }) => {
    const file = data.get("file");
    const projectId = data.get("projectId");
    const title = data.get("title");
    if (!(file instanceof File) || typeof projectId !== "string" || !projectId)
      throw refusal(400, "Expected a Word file and a project");
    if (file.size > WORD_LIMITS.compressedBytes)
      throw refusal(
        413,
        `A Word file can be at most ${WORD_LIMITS.compressedBytes / 1024 / 1024} MB.`,
      );
    const bytes = new Uint8Array(await file.arrayBuffer());
    return runServerFn(
      createFromWord(context.session.user.id, {
        owner: { projectId },
        title: typeof title === "string" ? title.slice(0, DOCUMENT_LIMITS.title) : undefined,
        by: "user",
        file: { name: file.name, mediaType: file.type, bytes },
      }),
    );
  });
/** A chat's or a project's document, renamed by someone who may edit it. */
export const renameDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(RenameDocumentInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.rename(context.session.user.id, data.documentId, data.title.trim()),
      ),
    ),
  );
/** Puts the editor's own image upload in the document; answers with the address to show it at. */
export const addDocumentImage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DocumentImageInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) => service.addImage(context.session.user.id, data)),
    ),
  );
export const deleteProjectDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DocumentIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.remove(context.session.user.id, data.documentId),
      ),
    ),
  );

export const commentOnDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(CommentInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) => service.comment(context.session.user.id, data)),
    ),
  );
export const resolveDocumentThread = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ResolveThreadInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.resolveThread(context.session.user.id, data),
      ),
    ),
  );
export const deleteDocumentComment = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DeleteCommentInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.deleteComment(context.session.user.id, data),
      ),
    ),
  );
