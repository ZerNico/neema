import { Context, Effect, Layer } from "effect";
import {
  createJobRuntime,
  JobError,
  workerCount,
  workerEntry,
  type JobRuntime,
} from "~/server/jobs.ts";
import type { PoolWorker } from "~/server/worker-pool.ts";
import { PDF_WORKERS } from "../limits.ts";
import type { pdfJobs } from "./runtime-worker.ts";

export type PdfJobs = typeof pdfJobs;
export type PdfRuntime = JobRuntime<PdfJobs>;

/** A PDF job that failed; `code` is stable, `message` reads as the reason a page or file was not read. */
export class PdfJobError extends JobError {}

export const pdfWorkerUrl = workerEntry(import.meta.url, "./runtime-worker.ts", "pdf-worker.mjs");

/**
 * PDFs are read, rendered and recognised in killable worker processes: a
 * hostile file, a native canvas or the recognition models can then only cost
 * the worker, never the server.
 */
export const createPdfRuntime = (
  entry: URL | (() => URL),
  options: { readonly workers?: number; readonly spawn?: (url: URL) => PoolWorker } = {},
): PdfRuntime =>
  createJobRuntime<PdfJobs>({
    entry,
    label: "PDF reading",
    workers: options.workers ?? PDF_WORKERS.defaultWorkers,
    queue: PDF_WORKERS.queue,
    timeoutMs: PDF_WORKERS.timeoutMs,
    heapMb: PDF_WORKERS.heapMb,
    perOwner: PDF_WORKERS.perOwner,
    errorOf: (code, message) => new PdfJobError(code, message),
    ...(options.spawn ? { spawn: options.spawn } : {}),
  });

export class PdfWorkers extends Context.Service<PdfWorkers, PdfRuntime>()("chat/pdf/PdfWorkers") {
  static readonly layer = Layer.effect(
    PdfWorkers,
    Effect.gen(function* () {
      const workers = yield* workerCount(
        "PDF_WORKERS",
        PDF_WORKERS.defaultWorkers,
        PDF_WORKERS.maxWorkers,
      );
      return yield* Effect.acquireRelease(
        Effect.sync(() => createPdfRuntime(pdfWorkerUrl, { workers })),
        (runtime) => Effect.promise(() => runtime.close()),
      );
    }),
  );
}
