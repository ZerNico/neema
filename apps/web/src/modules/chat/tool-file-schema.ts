import { Schema } from "effect";

/**
 * A `publish_file` or `create_file` call as its tool row keeps it and its result chunk carries:
 * which draft it delivered and the attachment that became.
 */
export const ToolFileActivity = Schema.Struct({
  ok: Schema.Boolean,
  ref: Schema.optionalKey(Schema.String),
  workingFileId: Schema.optionalKey(Schema.String),
  attachmentId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type ToolFileActivity = typeof ToolFileActivity.Type;

export const ToolFileEnvelope = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    family: Schema.Literal("tool-file"),
    phase: Schema.Literal("start"),
    callId: Schema.String,
    name: Schema.Literals(["publish_file", "create_file"]),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.Int,
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    family: Schema.Literal("tool-file"),
    phase: Schema.Literal("result"),
    callId: Schema.String,
    name: Schema.Literals(["publish_file", "create_file"]),
    ...ToolFileActivity.fields,
  }),
]);
