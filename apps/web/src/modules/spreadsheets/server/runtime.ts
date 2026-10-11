import { Context, Effect, Layer } from "effect";
import {
  createJobRuntime,
  workerCount,
  workerEntry,
  type JobRequest,
  type JobRuntime,
} from "~/server/jobs.ts";
import type { PoolWorker } from "~/server/worker-pool.ts";
import { SpreadsheetError } from "../errors.ts";
import { SPREADSHEET_LIMITS, SPREADSHEET_WORKERS } from "../limits.ts";
import { parseSpreadsheetOperations } from "../operations.ts";
import type { spreadsheetJobs } from "./runtime-worker.ts";

export type SpreadsheetJobs = typeof spreadsheetJobs;
export type SpreadsheetWork = JobRequest<SpreadsheetJobs>;
export type SpreadsheetRuntime = JobRuntime<SpreadsheetJobs>;

export const spreadsheetWorkerUrl = workerEntry(
  import.meta.url,
  "./runtime-worker.ts",
  "spreadsheet-worker.mjs",
);

/** Checks what the parent can before any worker is involved. */
function admit(request: SpreadsheetWork) {
  if (request.kind === "create" || request.kind === "exportLive") return;
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
export const createSpreadsheetRuntime = (
  entry: URL | (() => URL),
  options: { readonly workers?: number; readonly spawn?: (url: URL) => PoolWorker } = {},
): SpreadsheetRuntime =>
  createJobRuntime<SpreadsheetJobs>({
    entry,
    label: "Spreadsheet processing",
    workers: options.workers ?? SPREADSHEET_WORKERS.defaultWorkers,
    queue: SPREADSHEET_WORKERS.queue,
    timeoutMs: SPREADSHEET_WORKERS.timeoutMs,
    heapMb: SPREADSHEET_WORKERS.heapMb,
    perOwner: SPREADSHEET_WORKERS.perOwner,
    errorOf: (code, message) => new SpreadsheetError(code, message),
    admit,
    ...(options.spawn ? { spawn: options.spawn } : {}),
  });

/** The process's spreadsheet workers, shared by chat tools and previews. */
export class SpreadsheetProcessor extends Context.Service<
  SpreadsheetProcessor,
  SpreadsheetRuntime
>()("chat/spreadsheets/SpreadsheetProcessor") {
  static readonly layer = Layer.effect(
    SpreadsheetProcessor,
    Effect.gen(function* () {
      const workers = yield* workerCount(
        "SPREADSHEET_WORKERS",
        SPREADSHEET_WORKERS.defaultWorkers,
        SPREADSHEET_WORKERS.maxWorkers,
      );
      return yield* Effect.acquireRelease(
        Effect.sync(() => createSpreadsheetRuntime(spreadsheetWorkerUrl, { workers })),
        (runtime) => Effect.promise(() => runtime.close()),
      );
    }),
  );
}
