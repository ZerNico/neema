import { Schema } from "effect";

/**
 * A collection/document/version the caller may not use. Nonexistent and
 * forbidden are deliberately the same answer: distinguishing them would let a
 * caller probe for ids they cannot access.
 */
export class KnowledgeNotAvailable extends Schema.TaggedError<KnowledgeNotAvailable>()(
  "KnowledgeNotAvailable",
  { resourceId: Schema.String },
) {}

export class KnowledgeRejected extends Schema.TaggedError<KnowledgeRejected>()(
  "KnowledgeRejected",
  { reason: Schema.String },
) {}

/** Sharing into a group the caller is not allowed to share into. */
export class SharingNotAllowed extends Schema.TaggedError<SharingNotAllowed>()(
  "SharingNotAllowed",
  { reason: Schema.String },
) {}
