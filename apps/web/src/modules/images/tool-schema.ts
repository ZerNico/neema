import { IMAGE_QUALITIES, type ImageQuality } from "@chat/model-client";
import { Schema } from "effect";

export const IMAGE_TOOL = "generate_image";

/** Display bounds: a row shows a caption, never a transport for the prompt. */
export const IMAGE_ACTIVITY_LIMITS = {
  model: 120,
  prompt: 500,
  note: 300,
  adjustments: 6,
} as const;

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** What the call's row keeps and its result chunk carries. Never bytes. */
export const ImageToolActivity = Schema.Struct({
  family: Schema.Literal("image"),
  version: Schema.Literal(1),
  // `running` is the snapshot a call's row holds until its result replaces it.
  status: Schema.Literals(["running", "complete", "error"]),
  model: bounded(IMAGE_ACTIVITY_LIMITS.model),
  /** True when references were sent, so the row says it edited. */
  editing: Schema.Boolean,
  aspectRatio: Schema.optionalKey(Schema.String),
  requested: Schema.Int,
  /** The attachments the call produced, in order. */
  attachmentIds: Schema.Array(Schema.String),
  /** The quality sent; absent when the provider picked it or the model has none. */
  quality: Schema.optionalKey(Schema.Literals(IMAGE_QUALITIES)),
  adjustments: Schema.optionalKey(
    Schema.Array(bounded(IMAGE_ACTIVITY_LIMITS.note)).check(
      Schema.isMaxLength(IMAGE_ACTIVITY_LIMITS.adjustments),
    ),
  ),
  /** The provider declined the prompt; its own words. */
  refusal: Schema.optionalKey(bounded(IMAGE_ACTIVITY_LIMITS.note)),
  error: Schema.optionalKey(bounded(IMAGE_ACTIVITY_LIMITS.note)),
});
export type ImageToolActivity = typeof ImageToolActivity.Type;

const envelopeFields = {
  v: Schema.Literal(1),
  family: Schema.Literal("image"),
  name: Schema.Literal(IMAGE_TOOL),
  callId: Schema.String,
};

export const ImageToolEnvelope = Schema.Union([
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literal("start"),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int),
    model: bounded(IMAGE_ACTIVITY_LIMITS.model),
    editing: Schema.Boolean,
    aspectRatio: Schema.optionalKey(Schema.String),
    count: Schema.Int,
  }),
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literal("result"),
    ...ImageToolActivity.fields,
    status: Schema.Literals(["complete", "error"]),
  }),
]);
export type ImageToolEnvelope = typeof ImageToolEnvelope.Type;

const clamp = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** What a call draws, as its row and chunks show it from the start. */
export interface ImageCallShape {
  readonly model: string;
  readonly editing: boolean;
  readonly aspectRatio?: string | undefined;
  readonly requested: number;
}

const shapeFields = (shape: ImageCallShape) => ({
  model: clamp(shape.model, IMAGE_ACTIVITY_LIMITS.model),
  editing: shape.editing,
  ...(shape.aspectRatio ? { aspectRatio: shape.aspectRatio } : {}),
  requested: shape.requested,
});

/** The snapshot a call's row holds until its result replaces it. */
export const runningImageActivity = (shape: ImageCallShape): ImageToolActivity => ({
  family: "image",
  version: 1,
  status: "running",
  ...shapeFields(shape),
  attachmentIds: [],
});

/** The one projection into a row and a chunk, bounded wherever it came from. */
export const imageActivity = (
  input: ImageCallShape & {
    attachmentIds: ReadonlyArray<string>;
    quality?: ImageQuality | undefined;
    adjustments?: ReadonlyArray<string> | undefined;
    refusal?: string | undefined;
    error?: string | undefined;
  },
): ImageToolActivity & { status: "complete" | "error" } => ({
  family: "image",
  version: 1,
  status: input.attachmentIds.length > 0 && !input.error ? "complete" : "error",
  ...shapeFields(input),
  attachmentIds: [...input.attachmentIds],
  ...(input.quality ? { quality: input.quality } : {}),
  ...(input.adjustments?.length
    ? {
        adjustments: input.adjustments
          .slice(0, IMAGE_ACTIVITY_LIMITS.adjustments)
          .map((line) => clamp(line, IMAGE_ACTIVITY_LIMITS.note)),
      }
    : {}),
  ...(input.refusal ? { refusal: clamp(input.refusal, IMAGE_ACTIVITY_LIMITS.note) } : {}),
  ...(input.error ? { error: clamp(input.error, IMAGE_ACTIVITY_LIMITS.note) } : {}),
});
