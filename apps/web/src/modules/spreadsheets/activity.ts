import { Option, Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What an inspection covered: a sheet by position and a cell range. Never names or values. */
export const SpreadsheetRead = Schema.Struct({
  sheet: Count,
  range: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[A-Z]{1,3}\d{1,7}(?::[A-Z]{1,3}\d{1,7})?$/)),
  ),
});

const fields = {
  outcome: Schema.String,
  message: Schema.String,
  workingFileId: Schema.String,
  revision: Count,
  sheetCount: Count,
  origin: Schema.Literals(["created", "opened"]),
  changes: Schema.String,
  cellsWritten: Count,
  formulaErrors: Count,
  read: SpreadsheetRead,
};
/**
 * What a spreadsheet call leaves in the transcript. The engine persists it, the
 * stream carries it and the reload projection reads it back through the same
 * bounds. Cell contents and sheet names are file text and never appear.
 */
export const SpreadsheetActivityFields = {
  outcome: fields.outcome,
  message: fields.message,
  workingFileId: Schema.optionalKey(fields.workingFileId),
  revision: Schema.optionalKey(fields.revision),
  sheetCount: Schema.optionalKey(fields.sheetCount),
  origin: Schema.optionalKey(fields.origin),
  changes: Schema.optionalKey(fields.changes),
  cellsWritten: Schema.optionalKey(fields.cellsWritten),
  formulaErrors: Schema.optionalKey(fields.formulaErrors),
  read: Schema.optionalKey(fields.read),
};
const Summary = Schema.Struct(SpreadsheetActivityFields);
export type SpreadsheetActivitySummary = typeof Summary.Type;

const decoded = <T>(schema: Schema.Codec<T>, value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
const bounded = (value: string | undefined, max: number) =>
  value ? value.slice(0, max) : undefined;

export function spreadsheetActivitySummary(
  raw: unknown,
  failed: boolean,
): SpreadsheetActivitySummary {
  const result: Record<string, unknown> = raw && typeof raw === "object" ? { ...raw } : {};
  const workingFileId = bounded(decoded(fields.workingFileId, result.workingFileId), 100);
  const revision = decoded(fields.revision, result.revision);
  const sheetCount = decoded(fields.sheetCount, result.sheetCount);
  const origin = decoded(fields.origin, result.origin);
  const changes = bounded(decoded(fields.changes, result.changes), 300);
  const cellsWritten = decoded(fields.cellsWritten, result.cellsWritten);
  // The engine reports `{ count }`; a summary read back from a row already holds the number.
  const errors = result.formulaErrors as { count?: unknown } | number | undefined;
  const formulaErrors = decoded(
    fields.formulaErrors,
    typeof errors === "number" ? errors : errors?.count,
  );
  const read = decoded(fields.read, result.read);
  return {
    outcome: failed ? "error" : (bounded(decoded(fields.outcome, result.outcome), 40) ?? "error"),
    message:
      bounded(decoded(fields.message, result.message), 500) ?? "Spreadsheet operation failed.",
    ...(workingFileId ? { workingFileId } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(sheetCount !== undefined ? { sheetCount } : {}),
    ...(origin ? { origin } : {}),
    ...(changes ? { changes } : {}),
    ...(cellsWritten !== undefined ? { cellsWritten } : {}),
    ...(formulaErrors ? { formulaErrors } : {}),
    ...(read ? { read } : {}),
  };
}
