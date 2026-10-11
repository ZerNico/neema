import { Effect } from "effect";
import { SpreadsheetError } from "~/modules/spreadsheets/errors.ts";
import type { LiveSheetImport } from "~/modules/spreadsheets/server/adapter.ts";
import type { SpreadsheetRuntime } from "~/modules/spreadsheets/server/runtime.ts";
import { readCsv } from "./import.ts";

/**
 * A file read for a sheet to start from: a CSV here, an Excel workbook in a
 * spreadsheet worker, whose package checks and timeout guard the parse.
 */
export function readSheetFile(
  file: { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array },
  runtime: SpreadsheetRuntime | null,
  owner: string,
): Effect.Effect<{ name: string; read: LiveSheetImport }, string> {
  const { name } = file;
  if (/\.csv$/i.test(name) || file.mediaType === "text/csv")
    return Effect.sync(() => ({
      name,
      read: readCsv(new TextDecoder().decode(file.bytes), name.replace(/\.csv$/i, "")),
    }));
  if (!/\.xls[xm]$/i.test(name) && !file.mediaType.includes("spreadsheetml"))
    return Effect.fail(`${name} is not an Excel file or a CSV.`);
  if (!runtime) return Effect.fail("Excel files cannot be read on this server.");
  return Effect.tryPromise({
    try: () => runtime.run({ kind: "importLive", bytes: file.bytes }, undefined, { owner }),
    catch: (error) =>
      error instanceof SpreadsheetError ? error.message : `${name} could not be read.`,
  }).pipe(Effect.map((read) => ({ name, read })));
}
