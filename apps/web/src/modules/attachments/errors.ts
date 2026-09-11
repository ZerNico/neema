import { Schema } from "effect";

// Upload was refused before anything was stored. `reason` is safe to show the
// user — it only ever describes their own file.
export class AttachmentRejected extends Schema.TaggedError<AttachmentRejected>()(
  "AttachmentRejected",
  {
    cause: Schema.Literals(["size", "type", "content", "name", "count"]),
    reason: Schema.String,
  },
) {}

// Nonexistent id, someone else's attachment, and an already-claimed attachment
// all raise this one error: the caller must not be able to tell them apart.
export class AttachmentNotAvailable extends Schema.TaggedError<AttachmentNotAvailable>()(
  "AttachmentNotAvailable",
  { attachmentId: Schema.String },
) {}

export class BlobStoreError extends Schema.TaggedError<BlobStoreError>()("BlobStoreError", {
  operation: Schema.Literals(["put", "get", "delete", "exists", "deletePrefix"]),
  key: Schema.String,
  message: Schema.String,
}) {}

export class DocumentParseError extends Schema.TaggedError<DocumentParseError>()(
  "DocumentParseError",
  { fileName: Schema.String, reason: Schema.String },
) {}

/** The selected model cannot take this attachment and nothing can convert it. */
export class AttachmentUnsupported extends Schema.TaggedError<AttachmentUnsupported>()(
  "AttachmentUnsupported",
  { fileName: Schema.String, reason: Schema.String },
) {}
