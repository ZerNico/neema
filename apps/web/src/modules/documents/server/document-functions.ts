import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { refusal } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  CommentInput,
  NewDocumentInput,
  DOCUMENT_LIMITS,
  DeleteCommentInput,
  DocumentIdInput,
  DocumentImageInput,
  DocumentVersionInput,
  NameDocumentVersionInput,
  CopyDocumentInput,
  ShareDocumentInput,
  ProjectDocumentsInput,
  PushDocumentInput,
  RenameDocumentInput,
  ResolveThreadInput,
} from "../schema.ts";
import { DocumentService } from "./document-service.ts";
import { createFromWord } from "./create-from-word.ts";
import { plainTextMarkdown } from "../editor/plain-text.ts";
import { WORD_LIMITS } from "~/modules/word/limits.ts";

/** A Markdown or text upload; the document's own character cap still applies after. */
const TEXT_UPLOAD_BYTES = 1024 * 1024;

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
/** Names a version so it is kept, or takes the name off when blank. */
export const nameDocumentVersion = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(NameDocumentVersionInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.nameVersion(
          context.session.user.id,
          data.documentId,
          data.revision,
          data.name.trim() || null,
        ),
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
/** A person starting a blank document, in a project or their own; the model has its own tool. */
export const createDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(NewDocumentInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.create(context.session.user.id, {
          ...(data.projectId ? { projectId: data.projectId } : {}),
          title: data.title,
          content: "",
          by: "user",
        }),
      ).pipe(Effect.map((result) => result.document)),
    ),
  );
/** How an upload starts a document, by its name: Word is imported, Markdown and text are read. */
const uploadKind = (name: string) => {
  const extension = name.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (extension === "docx") return "word";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "txt") return "text";
  return null;
};

/**
 * A document started from a Word, Markdown or text file, in a project or the
 * person's own: multipart, since the file is bytes. Answers what the file held
 * that a document cannot, to show the person.
 */
export const createDocumentFromFile = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator((data: FormData) => data)
  .handler(async ({ context, data }) => {
    const file = data.get("file");
    const projectId = data.get("projectId");
    const title = data.get("title");
    const kind = file instanceof File ? uploadKind(file.name) : null;
    if (!(file instanceof File) || !kind || (projectId !== null && typeof projectId !== "string"))
      throw refusal(400, localized(m.documents_import_expected_file));
    const place = projectId ? { projectId } : {};
    const named = typeof title === "string" ? title.slice(0, DOCUMENT_LIMITS.title) : undefined;
    if (kind !== "word") {
      if (file.size > TEXT_UPLOAD_BYTES)
        throw refusal(
          413,
          localized(m.documents_import_text_too_large, { max: TEXT_UPLOAD_BYTES / 1024 / 1024 }),
        );
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw refusal(422, localized(m.documents_import_text_unreadable));
      }
      const document = await runServerFn(
        Effect.flatMap(DocumentService, (service) =>
          service.create(context.session.user.id, {
            ...place,
            title: (named?.trim() || file.name.replace(/\.[^.]+$/, "").trim() || file.name).slice(
              0,
              DOCUMENT_LIMITS.title,
            ),
            content: kind === "text" ? plainTextMarkdown(text) : text,
            by: "user",
          }),
        ).pipe(Effect.map((result) => result.document)),
      );
      return { document, dropped: [] as string[] };
    }
    if (file.size > WORD_LIMITS.compressedBytes)
      throw refusal(
        413,
        localized(m.documents_import_too_large, {
          max: WORD_LIMITS.compressedBytes / 1024 / 1024,
        }),
      );
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Read while still in the request: the effect's fibers do not carry it.
    const locale = getLocale();
    const created = await runServerFn(
      createFromWord(context.session.user.id, {
        owner: projectId ? { projectId } : { userId: context.session.user.id },
        title: named,
        by: "user",
        locale,
        file: { name: file.name, mediaType: file.type, bytes },
      }),
    );
    return { ...created, dropped: created.dropped.map((text) => text(locale)) };
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
/** The person's own documents, for their library. */
export const listDocumentLibrary = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) => service.library(context.session.user.id)),
    ),
  );
/** A copy of a document the person may read, into a project they may edit. */
export const copyDocumentToProject = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(CopyDocumentInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.copyToProject(context.session.user.id, data.documentId, data.projectId),
      ),
    ),
  );
/** Who a person's document is shared with. */
export const getDocumentSharing = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DocumentIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.sharing(context.session.user.id, data.documentId),
      ),
    ),
  );
export const shareDocument = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ShareDocumentInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(DocumentService, (service) =>
        service.share(context.session.user.id, data.documentId, data.change),
      ),
    ),
  );
export const deleteDocument = createServerFn({ method: "POST" })
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
