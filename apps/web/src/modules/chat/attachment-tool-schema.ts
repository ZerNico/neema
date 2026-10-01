import { Schema } from "effect";

/** What `read_attachment` returns at most per call. */
export const ATTACHMENT_READ_LIMITS = {
  defaultChars: 20_000,
  maxChars: 40_000,
  matches: 50,
  matchLineChars: 300,
  patternChars: 200,
} as const;

/**
 * Durable and displayed: which file and what part of it, never its text. The
 * text reaches only the model, in the call's own result.
 */
export const AttachmentReadActivity = Schema.Struct({
  ok: Schema.Boolean,
  fileName: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.Literals(["range", "search"])),
  from: Schema.optionalKey(Schema.Int),
  to: Schema.optionalKey(Schema.Int),
  total: Schema.optionalKey(Schema.Int),
  matches: Schema.optionalKey(Schema.Int),
  error: Schema.optionalKey(Schema.String),
});
export type AttachmentReadActivity = typeof AttachmentReadActivity.Type;

const envelopeFields = {
  v: Schema.Literals([1]),
  family: Schema.Literals(["attachment"]),
  callId: Schema.String,
  name: Schema.Literals(["read_attachment"]),
};

export const AttachmentToolEnvelope = Schema.Union([
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literals(["start"]),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literals(["result"]),
    ...AttachmentReadActivity.fields,
  }),
]);
