import { Context, Layer } from "effect";
import { jobFamily, workerEntry, type JobRequest, type JobRuntime } from "~/server/jobs.ts";
import { SpreadsheetError } from "../errors.ts";
import { SPREADSHEET_LIMITS, SPREADSHEET_WORKERS } from "../limits.ts";
import { parseSpreadsheetOperations } from "../operations.ts";
import type { spreadsheetJobs } from "./runtime-worker.ts";

export type SpreadsheetJobs = typeof spreadsheetJobs;
export type SpreadsheetWork = JobRequest<SpreadsheetJobs>;
export type SpreadsheetRuntime = JobRuntime<SpreadsheetJobs>;

/** Checks what the parent can before any worker is involved. */
function admit(request: SpreadsheetWork) {
  if (request.kind === "create") return;
  if (request.bytes.length > SPREADSHEET_LIMITS.compressedBytes)
    throw new SpreadsheetError(
      "limit",
      `A workbook can be at most ${SPREADSHEET_LIMITS.compressedBytes / 1024 / 1024} MiB.`,
    );
  if (request.kind === "edit") parseSpreadsheetOperations(request.operations);
}

/**
 * Workbooks are parsed and calculated in killable worker processes, since a
 * workbook's formulas can be made arbitrarily expensive; the timeout ends them.
 */
const spreadsheetFamily = jobFamily<SpreadsheetJobs>({
  entry: workerEntry(import.meta.url, "./runtime-worker.ts", "spreadsheet-worker.mjs"),
  env: "SPREADSHEET_WORKERS",
  label: "Spreadsheet processing",
  settings: SPREADSHEET_WORKERS,
  errorOf: (code, message) => new SpreadsheetError(code, message),
  admit,
});
export const createSpreadsheetRuntime = spreadsheetFamily.create;

/** The process's spreadsheet workers, shared by chat tools and previews. */
export class SpreadsheetProcessor extends Context.Service<
  SpreadsheetProcessor,
  SpreadsheetRuntime
>()("chat/spreadsheets/SpreadsheetProcessor") {
  static readonly layer = Layer.effect(SpreadsheetProcessor, spreadsheetFamily.runtime);
}
