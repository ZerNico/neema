import { Context, Layer } from "effect";
import { jobFamily, workerEntry, type JobRequest, type JobRuntime } from "~/server/jobs.ts";
import { WordError } from "../errors.ts";
import { WORD_LIMITS, WORD_WORKERS } from "../limits.ts";
import { parseWordOperations } from "../operations.ts";
import type { wordJobs } from "./runtime-worker.ts";

export type WordJobs = typeof wordJobs;
export type WordWork = JobRequest<WordJobs>;
export type WordRuntime = JobRuntime<WordJobs>;

/** Checks what the parent can before any worker is involved. */
function admit(request: WordWork) {
  // A document's own tree and images, bounded by the document's limits before it gets here.
  if (request.kind === "create" || request.kind === "exportDocument") return;
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
const wordFamily = jobFamily<WordJobs>({
  entry: workerEntry(import.meta.url, "./runtime-worker.ts", "word-worker.mjs"),
  env: "WORD_WORKERS",
  label: "Word processing",
  settings: WORD_WORKERS,
  errorOf: (code, message) => new WordError(code, message),
  admit,
});
export const createWordRuntime = wordFamily.create;

/** The process's Word workers, shared by chat tools and previews. */
export class WordProcessor extends Context.Service<WordProcessor, WordRuntime>()(
  "chat/word/WordProcessor",
) {
  static readonly layer = Layer.effect(WordProcessor, wordFamily.runtime);
}
