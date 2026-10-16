import { Schema } from "effect";

/**
 * Tool families offered by name only until loaded. Their schemas are large or
 * rarely needed, so a chat pays for them once it actually works on that kind
 * of thing; see `docs/internals/prompt-caching.md`.
 */
export const LazyToolFamily = Schema.Literals([
  "presentation",
  "spreadsheet",
  "word",
  "agent-draft",
  "schedule-draft",
]);
export type LazyToolFamily = typeof LazyToolFamily.Type;

/** What a `load_tools` call made available, durable on its row. */
export const LoadToolsResult = Schema.Struct({
  loaded: Schema.Array(LazyToolFamily),
  /** Requested names this attempt does not offer. */
  unavailable: Schema.Array(Schema.String),
});
export type LoadToolsResult = typeof LoadToolsResult.Type;

const envelopeFields = {
  v: Schema.Literals([1]),
  family: Schema.Literals(["tool-load"]),
  callId: Schema.String,
  name: Schema.Literals(["load_tools"]),
};

export const ToolLoadEnvelope = Schema.Union([
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
    ok: Schema.Boolean,
    loaded: Schema.optionalKey(Schema.Array(LazyToolFamily)),
  }),
]);
