import { Schema } from "effect";
import { WordActivityFields } from "./activity.ts";

export const WordToolName = Schema.Literals(["inspect_word_file", "edit_word_file"]);
export type WordToolName = typeof WordToolName.Type;

/** The transcript envelope of a Word call: a start marker, then its bounded activity. */
export const WordToolEnvelope = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    family: Schema.Literal("word"),
    phase: Schema.Literal("start"),
    callId: Schema.String,
    name: WordToolName,
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.Int,
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    family: Schema.Literal("word"),
    phase: Schema.Literal("result"),
    callId: Schema.String,
    name: WordToolName,
    ...WordActivityFields,
  }),
]);
