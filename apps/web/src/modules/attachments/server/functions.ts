import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { MAX_ATTACHMENT_BYTES } from "../constants.ts";
import { AttachmentIdInput } from "../schema.ts";
import { AttachmentService } from "./service.ts";
import { DocumentParser } from "./document-parser.ts";

const standard = Schema.toStandardSchemaV1;

// FormData has to sit at the root of `data` for the client to send a multipart
// body, so the file is pulled out here rather than by a Schema validator.
const readUpload = (data: FormData) => {
  const file = data.get("file");
  if (!(file instanceof File)) {
    throw new Response("Expected a file", { status: 400 });
  }
  // The body is already buffered by the time we see it; this cap only stops
  // us from hashing and storing something oversized.
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Response("File is too large", { status: 413 });
  }
  return file;
};

export const uploadAttachment = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator((data: FormData) => data)
  .handler(async ({ data, context }) => {
    const file = readUpload(data);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return runtime.runPromise(
      AttachmentService.use((service) =>
        service.upload({
          userId: context.session.user.id,
          fileName: file.name,
          declaredMediaType: file.type,
          bytes,
        }),
      ).pipe(
        Effect.catchTag("AttachmentRejected", (error) =>
          Effect.die(new Response(error.reason, { status: error.cause === "size" ? 413 : 415 })),
        ),
      ),
    );
  });

export const deleteAttachment = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(AttachmentIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      AttachmentService.use((service) =>
        service.remove({
          userId: context.session.user.id,
          attachmentId: data.attachmentId,
        }),
      ).pipe(
        // Unknown, someone else's, and already-sent all answer the same way.
        Effect.catchTag("AttachmentNotAvailable", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
      ),
    ),
  );

export const getDocumentParsingAvailability = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() => runtime.runPromise(DocumentParser.use((parser) => parser.availability())));
