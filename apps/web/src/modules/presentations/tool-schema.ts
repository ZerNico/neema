import { Schema } from "effect";
import { PresentationActivityFields } from "./activity.ts";

export const PresentationToolName = Schema.Literals([
  "inspect_presentation",
  "edit_presentation",
  "render_presentation",
]);
export type PresentationToolName = typeof PresentationToolName.Type;

/** The transcript envelope of a presentation call: a start marker, then its bounded activity. */
export const PresentationToolEnvelope = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    family: Schema.Literal("presentation"),
    phase: Schema.Literal("start"),
    callId: Schema.String,
    name: PresentationToolName,
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.Int,
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    family: Schema.Literal("presentation"),
    phase: Schema.Literal("result"),
    callId: Schema.String,
    name: PresentationToolName,
    ...PresentationActivityFields,
  }),
]);
