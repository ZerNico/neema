import { Schema } from "effect";
import { SpreadsheetActivityFields } from "./activity.ts";

export const SpreadsheetToolName = Schema.Literals(["inspect_spreadsheet", "edit_spreadsheet"]);
export type SpreadsheetToolName = typeof SpreadsheetToolName.Type;

/** The transcript envelope of a spreadsheet call: a start marker, then its bounded activity. */
export const SpreadsheetToolEnvelope = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    family: Schema.Literal("spreadsheet"),
    phase: Schema.Literal("start"),
    callId: Schema.String,
    name: SpreadsheetToolName,
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.Int,
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    family: Schema.Literal("spreadsheet"),
    phase: Schema.Literal("result"),
    callId: Schema.String,
    name: SpreadsheetToolName,
    ...SpreadsheetActivityFields,
  }),
]);
