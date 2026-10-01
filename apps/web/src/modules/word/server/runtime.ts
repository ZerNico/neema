import { Context, Effect, Layer } from "effect";
import {
  createJobRuntime,
  workerCount,
  workerEntry,
  type JobRequest,
  type JobRuntime,
} from "~/server/jobs.ts";
import type { PoolWorker } from "~/server/worker-pool.ts";
import { WordError } from "../errors.ts";
import { WORD_LIMITS, WORD_WORKERS } from "../limits.ts";
import { parseWordOperations } from "../operations.ts";
import type { wordJobs } from "./runtime-worker.ts";

export type WordJobs = typeof wordJobs;
export type WordWork = JobRequest<WordJobs>;
export type WordRuntime = JobRuntime<WordJobs>;

export const wordWorkerUrl = workerEntry(import.meta.url, "./runtime-worker.ts", "word-worker.mjs");

/** Checks what the parent can before any worker is involved. */
function admit(request: WordWork) {
  if (request.kind === "create") return;
  if (request.bytes.length > WORD_LIMITS.compressedBytes)
    throw new WordError(
      "limit",
      `A Word file can be at most ${WORD_LIMITS.compressedBytes / 1024 / 1024} MiB.`,
    );
  if (request.kind === "edit") parseWordOperations(request.operations, "worker");
}

/**
 * Word files are parsed in killable worker processes: the parser has no
 * bounds of its own, so the package is measured first and the timeout ends
 * whatever still runs too long.
 */
export const createWordRuntime = (
  entry: URL | (() => URL),
  options: { readonly workers?: number; readonly spawn?: (url: URL) => PoolWorker } = {},
): WordRuntime =>
  createJobRuntime<WordJobs>({
    entry,
    label: "Word processing",
    workers: options.workers ?? WORD_WORKERS.defaultWorkers,
    queue: WORD_WORKERS.queue,
    timeoutMs: WORD_WORKERS.timeoutMs,
    heapMb: WORD_WORKERS.heapMb,
    perOwner: WORD_WORKERS.perOwner,
    errorOf: (code, message) => new WordError(code, message),
    admit,
    ...(options.spawn ? { spawn: options.spawn } : {}),
  });

/** The process's Word workers, shared by chat tools and previews. */
export class WordProcessor extends Context.Service<WordProcessor, WordRuntime>()(
  "chat/word/WordProcessor",
) {
  static readonly layer = Layer.effect(
    WordProcessor,
    Effect.gen(function* () {
      const workers = yield* workerCount(
        "WORD_WORKERS",
        WORD_WORKERS.defaultWorkers,
        WORD_WORKERS.maxWorkers,
      );
      return yield* Effect.acquireRelease(
        Effect.sync(() => createWordRuntime(wordWorkerUrl, { workers })),
        (runtime) => Effect.promise(() => runtime.close()),
      );
    }),
  );
}
