import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { refusal } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { MAX_ATTACHMENT_BYTES } from "../constants.ts";
import { AttachmentIdInput } from "../schema.ts";
import { AttachmentService } from "./service.ts";
import { DocumentParser } from "./document-parser.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";
import { AttachmentRejected } from "../errors.ts";

const standard = Schema.toStandardSchemaV1;

/**
 * FormData has to sit at the root of `data` for the client to send a multipart
 * body, so the file is pulled out here rather than by a Schema validator.
 */
export const readUpload = (data: FormData) => {
  const file = data.get("file");
  if (!(file instanceof File)) {
    throw refusal(400, "Expected a file");
  }
  // Bodies past every family's limit are refused before parsing (body-limit.ts);
  // this is the attachment's own, smaller one.
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw refusal(413, "File is too large");
  }
  return file;
};

export const uploadAttachment = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator((data: FormData) => data)
  .handler(async ({ data, context }) => {
    const file = readUpload(data);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return runServerFn(
      Effect.gen(function* () {
        // The feature governs what a person uploads; files a tool or the model
        // produces, and kept drafts, are stored without it.
        if (
          !(yield* FeaturePolicy.use((policy) =>
            policy.can(context.session.user.id, "attachments"),
          ))
        )
          return yield* new AttachmentRejected({
            cause: "type",
            reason: "attachments are unavailable",
          });
        yield* StorageQuota.use((quota) => quota.admit(context.session.user.id, [bytes]));
        return yield* AttachmentService.use((service) =>
          service.upload({
            userId: context.session.user.id,
            fileName: file.name,
            declaredMediaType: file.type,
            bytes,
          }),
        );
      }),
    );
  });

export const deleteAttachment = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(AttachmentIdInput))
  .handler(({ data, context }) =>
    runServerFn(
      AttachmentService.use(
        (service) =>
          service.remove({
            userId: context.session.user.id,
            attachmentId: data.attachmentId,
          }),
        // Unknown, someone else's, and already-sent all answer the same way.
      ),
    ),
  );

export const getDocumentParsingAvailability = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() => runServerFn(DocumentParser.use((parser) => parser.availability())));
