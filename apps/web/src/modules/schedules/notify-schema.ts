import { Schema } from "effect";

export const NOTIFY_MESSAGE_MAX = 300;

/** What a `notify_user` call kept: the text it will send, or why it did not. */
export const NotifyToolResult = Schema.Union([
  Schema.Struct({
    v: Schema.Literals([1]),
    outcome: Schema.Literals(["queued"]),
    message: Schema.String.check(Schema.isMaxLength(NOTIFY_MESSAGE_MAX)),
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    outcome: Schema.Literals(["rejected"]),
    message: Schema.String,
  }),
]);
export type NotifyToolResult = typeof NotifyToolResult.Type;
