import { Context, Effect, Layer } from "effect";
import {
  createJobRuntime,
  workerCount,
  workerEntry,
  type JobRequest,
  type JobRunOptions,
  type JobRuntime,
} from "~/server/jobs.ts";
import type { PoolWorker } from "~/server/worker-pool.ts";
import { PresentationError } from "../errors.ts";
import { PRESENTATION_LIMITS, PRESENTATION_WORKERS } from "../limits.ts";
import { parsePresentationOperations } from "../operations.ts";
import type { FontFace } from "./font-file.ts";
import type { presentationJobs } from "./runtime-worker.ts";

export type PresentationJobs = typeof presentationJobs;
export type PresentationWork = JobRequest<PresentationJobs>;

export interface PresentationRunOptions extends JobRunOptions {
  /** Faces for this job beside the uploaded ones, such as a loaded skill's fonts. */
  readonly faces?: readonly FontFace[];
}
export type PresentationRuntime = JobRuntime<PresentationJobs, PresentationRunOptions>;

export const presentationWorkerUrl = workerEntry(
  import.meta.url,
  "./runtime-worker.ts",
  "presentation-worker.mjs",
);

/** Checks what the parent can before any worker is involved; failures reject like any other. */
function admit(request: PresentationWork) {
  if (request.kind === "create" || request.kind === "font") return;
  if (request.kind === "chart") {
    // The spreadsheet worker bounds each chart part; its theme is one more part.
    if (request.chart.chart.length + request.chart.theme.length > 4 * 1024 * 1024)
      throw new PresentationError("limit", "The chart is too large to draw.");
    return;
  }
  if (request.bytes.length > PRESENTATION_LIMITS.compressedBytes)
    throw new PresentationError(
      "limit",
      `PPTX input exceeds ${PRESENTATION_LIMITS.compressedBytes / 1024 / 1024} MiB.`,
    );
  if (request.kind !== "edit") return;
  const imageBytes = parsePresentationOperations(request.operations).reduce(
    (total, op) =>
      total + (op.kind === "addImage" || op.kind === "replaceImage" ? op.imageRef.length : 0),
    0,
  );
  if (imageBytes > PRESENTATION_LIMITS.editImageBytes)
    throw new PresentationError(
      "limit",
      `Images in one edit call exceed ${PRESENTATION_LIMITS.editImageBytes / 1024 / 1024} MiB.`,
    );
}

/**
 * Decks are parsed, edited and rendered in killable worker processes; no parser
 * or renderer runs on the server's own thread.
 */
export const createPresentationRuntime = (
  entry: URL | (() => URL),
  options: { readonly workers?: number; readonly spawn?: (url: URL) => PoolWorker } = {},
): PresentationRuntime =>
  createJobRuntime<PresentationJobs>({
    entry,
    label: "PowerPoint processing",
    workers: options.workers ?? PRESENTATION_WORKERS.defaultWorkers,
    queue: PRESENTATION_WORKERS.queue,
    timeoutMs: PRESENTATION_WORKERS.timeoutMs,
    heapMb: PRESENTATION_WORKERS.heapMb,
    perOwner: PRESENTATION_WORKERS.perOwner,
    errorOf: (code, message) => new PresentationError(code, message),
    admit,
    ...(options.spawn ? { spawn: options.spawn } : {}),
  });

/**
 * The process's presentation workers, shared by font checks and the processor.
 * Both provide this same layer, which Effect builds once per runtime.
 */
export class PresentationWorkers extends Context.Service<
  PresentationWorkers,
  PresentationRuntime
>()("chat/presentations/PresentationWorkers") {
  static readonly layer = Layer.effect(
    PresentationWorkers,
    Effect.gen(function* () {
      const workers = yield* workerCount(
        "PRESENTATION_WORKERS",
        PRESENTATION_WORKERS.defaultWorkers,
        PRESENTATION_WORKERS.maxWorkers,
      );
      return yield* Effect.acquireRelease(
        Effect.sync(() => createPresentationRuntime(presentationWorkerUrl, { workers })),
        (runtime) => Effect.promise(() => runtime.close()),
      );
    }),
  );
}
