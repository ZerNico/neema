import { Schema } from "effect";
import { CUSTOM_TOOL_LIMITS } from "./schema.ts";

/**
 * What a custom tool handler returns after normalization. `output` is a
 * bounded string; the raw return value never crosses the boundary (the model
 * sees the same text the transcript would have carried).
 */
export const CustomToolResultFile = Schema.Struct({
  name: Schema.String,
  mediaType: Schema.String,
  size: Schema.Int,
  /** The stored attachment, so a later save_to_workspace can name it. */
  attachmentId: Schema.optional(Schema.String),
});

export const CustomToolResult = Schema.Struct({
  ok: Schema.Boolean,
  output: Schema.optional(Schema.String.check(Schema.isMaxLength(CUSTOM_TOOL_LIMITS.resultChars))),
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(CUSTOM_TOOL_LIMITS.errorChars))),
  /** Names only; the bytes are stored as attachments under the fence. */
  files: Schema.optional(Schema.Array(CustomToolResultFile)),
});
export type CustomToolResult = typeof CustomToolResult.Type;

/**
 * Display bounds: an activity row is a label plus a preview, never a
 * transport for the full result.
 */
export const CUSTOM_ACTIVITY_LIMITS = {
  name: 120,
  error: 300,
} as const;

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

const WorkingFileActivity = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  name: bounded(CUSTOM_ACTIVITY_LIMITS.name),
});

export const CustomToolActivity = Schema.Struct({
  family: Schema.Literal("custom"),
  version: Schema.Literal(1),
  /** Model-facing name (`custom_…`); the prefix is the durable discriminator. */
  name: bounded(CUSTOM_ACTIVITY_LIMITS.name),
  /** Human label resolved from the row at call time. */
  displayName: bounded(CUSTOM_ACTIVITY_LIMITS.name),
  status: Schema.Literals(["running", "complete", "error"]),
  /** First CUSTOM_TOOL_LIMITS.resultPreviewChars of the output. */
  resultPreview: Schema.optional(Schema.String),
  resultChars: Schema.optional(Schema.Int),
  error: Schema.optional(bounded(CUSTOM_ACTIVITY_LIMITS.error)),
  /** Attachments the call produced, in return order. */
  fileIds: Schema.optional(Schema.Array(Schema.String)),
  workingFiles: Schema.optional(Schema.Array(WorkingFileActivity)),
});
export type CustomToolActivity = typeof CustomToolActivity.Type;

const envelopeFields = {
  v: Schema.Literal(1),
  family: Schema.Literal("custom"),
  /** Model-facing name; not a closed literal set. */
  name: bounded(CUSTOM_ACTIVITY_LIMITS.name),
  callId: Schema.String,
};

export const CustomToolEnvelope = Schema.Union([
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literal("start"),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int),
    displayName: bounded(CUSTOM_ACTIVITY_LIMITS.name),
  }),
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literal("result"),
    displayName: bounded(CUSTOM_ACTIVITY_LIMITS.name),
    status: Schema.Literals(["complete", "error"]),
    resultPreview: Schema.optionalKey(Schema.String),
    resultChars: Schema.optionalKey(Schema.Int),
    error: Schema.optionalKey(bounded(CUSTOM_ACTIVITY_LIMITS.error)),
    fileIds: Schema.optionalKey(Schema.Array(Schema.String)),
    workingFiles: Schema.optionalKey(Schema.Array(WorkingFileActivity)),
  }),
]);

const clamp = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/**
 * The only tool-result persistence/wire projection. Custom tool names are
 * runtime data, so this takes the raw name rather than a literal union; the
 * prefix check already ran at dispatch.
 */
export function projectCustomToolResult(input: {
  name: string;
  displayName: string;
  raw: unknown;
  isFailure: boolean;
  fileIds?: ReadonlyArray<string>;
  workingFiles?: ReadonlyArray<{ id: string; revision: number; name: string }>;
}): CustomToolActivity {
  const parsed = Schema.decodeUnknownOption(CustomToolResult)(input.raw);
  const result = parsed._tag === "Some" ? parsed.value : null;
  const ok = !input.isFailure && result?.ok === true;
  const output = result?.output;
  const error =
    input.isFailure && !result?.error
      ? String(input.raw instanceof Error ? input.raw.message : input.raw)
      : result?.error;
  return {
    family: "custom",
    version: 1,
    name: clamp(input.name, CUSTOM_ACTIVITY_LIMITS.name),
    displayName: clamp(input.displayName, CUSTOM_ACTIVITY_LIMITS.name),
    status: ok ? "complete" : "error",
    ...(output !== undefined
      ? {
          resultPreview: clamp(output, CUSTOM_TOOL_LIMITS.resultPreviewChars),
          resultChars: output.length,
        }
      : {}),
    ...(!ok && error ? { error: clamp(String(error), CUSTOM_ACTIVITY_LIMITS.error) } : {}),
    ...(input.fileIds?.length ? { fileIds: [...input.fileIds] } : {}),
    ...(input.workingFiles?.length
      ? {
          workingFiles: input.workingFiles.map((file) => ({
            ...file,
            name: clamp(file.name, CUSTOM_ACTIVITY_LIMITS.name),
          })),
        }
      : {}),
  };
}
