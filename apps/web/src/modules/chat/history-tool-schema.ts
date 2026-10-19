import { Schema } from "effect";

/** What the history tools return at most per call. */
export const HISTORY_LIMITS = {
  /** Message text one page carries, all messages together. */
  pageChars: 12_000,
  defaultCount: 20,
  maxCount: 50,
  hits: 12,
  chatHits: 8,
  queryChars: 200,
} as const;

export const HistoryToolName = Schema.Literals(["read_history", "search_chats", "read_chat"]);
export type HistoryToolName = typeof HistoryToolName.Type;

/**
 * Durable and displayed: what was looked for and how much came back, never
 * the text. Message text reaches only the model, in the call's own result.
 */
export const HistoryActivity = Schema.Struct({
  ok: Schema.Boolean,
  query: Schema.optionalKey(Schema.String),
  chatId: Schema.optionalKey(Schema.String),
  chatTitle: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Message numbers of a page, first and last. */
  from: Schema.optionalKey(Schema.Int),
  to: Schema.optionalKey(Schema.Int),
  /** Messages in the chat read. */
  total: Schema.optionalKey(Schema.Int),
  matches: Schema.optionalKey(Schema.Int),
  error: Schema.optionalKey(Schema.String),
});
export type HistoryActivity = typeof HistoryActivity.Type;

const envelopeFields = {
  v: Schema.Literals([1]),
  family: Schema.Literals(["history"]),
  callId: Schema.String,
  name: HistoryToolName,
};

export const HistoryToolEnvelope = Schema.Union([
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
    ...HistoryActivity.fields,
  }),
]);
