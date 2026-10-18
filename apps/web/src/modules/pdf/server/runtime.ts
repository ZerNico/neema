import { Context, Layer } from "effect";
import { JobError, jobFamily, workerEntry, type JobRuntime } from "~/server/jobs.ts";
import { PDF_WORKERS } from "../limits.ts";
import type { pdfJobs } from "./runtime-worker.ts";

export type PdfJobs = typeof pdfJobs;
export type PdfRuntime = JobRuntime<PdfJobs>;

/** A PDF job that failed; `code` is stable, `message` reads as the reason a page or file was not read. */
export class PdfJobError extends JobError {}

/**
 * PDFs are read, rendered and recognised in killable worker processes: a
 * hostile file, a native canvas or the recognition models can then only cost
 * the worker, never the server.
 */
const pdfFamily = jobFamily<PdfJobs>({
  entry: workerEntry(import.meta.url, "./runtime-worker.ts", "pdf-worker.mjs"),
  env: "PDF_WORKERS",
  label: "PDF reading",
  settings: PDF_WORKERS,
  errorOf: (code, message) => new PdfJobError(code, message),
});
export const createPdfRuntime = pdfFamily.create;

export class PdfWorkers extends Context.Service<PdfWorkers, PdfRuntime>()("chat/pdf/PdfWorkers") {
  static readonly layer = Layer.effect(PdfWorkers, pdfFamily.runtime);
}
