import { createFileRoute } from "@tanstack/react-router";
import { calculateSheet } from "@chat/sheet/model/calc";
import { Effect } from "effect";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import {
  DOCX_MEDIA_TYPE,
  embeddedSheetIds,
  exportImages,
  wordExportInput,
  wordFileName,
  type EmbeddedSheet,
} from "~/modules/documents/server/word-export.ts";
import { SheetService } from "~/modules/documents/sheet/server/sheet-service.ts";
import { WordError } from "~/modules/word/errors.ts";
import { WordProcessor } from "~/modules/word/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";
import { runtime } from "~/server/runtime.ts";

/**
 * A text document as a Word file, built from the stored tree, for anyone who
 * may read it. Its images come only through the document that claimed them,
 * and its sheet embeds' values only from sheets the reader may read.
 */
export const Route = createFileRoute("/api/documents/$documentId/export")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const prepared = await runtime.runPromise(
          Effect.gen(function* () {
            const documents = yield* DocumentService;
            const read = yield* documents.read(session.user.id, params.documentId);
            if (!read) return null;
            const attachments = yield* AttachmentService;
            const images = yield* exportImages(read.document.id, read.doc, (attachmentId) =>
              attachments.readDocumentImage({ documentId: read.document.id, attachmentId }).pipe(
                Effect.map((file) => file.bytes),
                Effect.catchTag("AttachmentNotAvailable", () => Effect.succeed(null)),
              ),
            );
            // Each embedded sheet is read as this reader may read it, and calculated as its
            // own download calculates it; one they cannot read keeps its caption only.
            const sheetService = yield* SheetService;
            const sheets = new Map<string, EmbeddedSheet>();
            for (const sheetId of embeddedSheetIds(read.doc)) {
              const sheet = yield* sheetService.read(session.user.id, sheetId);
              if (!sheet) continue;
              sheets.set(sheetId, {
                title: sheet.document.title,
                doc: sheet.doc,
                values: calculateSheet(sheet.doc, {
                  revision: sheet.revision,
                  epoch: 0,
                  ...sheet.moment,
                }),
              });
            }
            return {
              title: read.document.title,
              input: wordExportInput(read.document.title, read.doc, read.comments, images, sheets),
              word: yield* WordProcessor,
            };
          }),
        );
        if (!prepared) return new Response("Not found", { status: 404 });
        try {
          const bytes = await prepared.word.run(
            { kind: "exportDocument", document: prepared.input },
            request.signal,
            { owner: session.user.id },
          );
          const name = wordFileName(prepared.title);
          return new Response(new Uint8Array(bytes), {
            headers: {
              "content-type": DOCX_MEDIA_TYPE,
              "content-disposition": `attachment; filename="document.docx"; filename*=UTF-8''${encodeURIComponent(name)}`,
              "cache-control": "private, no-store",
            },
          });
        } catch (error) {
          if (error instanceof WordError) return new Response(error.message, { status: 422 });
          throw error;
        }
      },
    },
  },
});
