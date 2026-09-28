import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Config, Context, Effect, Layer } from "effect";
import { createWorkerPool, type WorkerFailure } from "~/server/worker-pool.ts";
import { PresentationError } from "../errors.ts";
import { PRESENTATION_LIMITS, PRESENTATION_WORKERS } from "../limits.ts";
import { parsePresentationOperations } from "../operations.ts";
import type { editPresentation, inspectPresentation, renderPresentation } from "./adapter.ts";
import type { FontFace, FontFileInfo } from "./font-file.ts";
import type { InspectScope } from "./inspection.ts";

export type PresentationWork =
  | { readonly kind: "create" }
  | { readonly kind: "inspect"; readonly bytes: Uint8Array; readonly scope?: InspectScope }
  | {
      readonly kind: "edit";
      readonly bytes: Uint8Array;
      readonly operations: unknown;
      readonly fonts?: readonly FontFace[];
      /** Return the layout catalog too, for a deck the model has not inspected. */
      readonly catalog?: boolean;
    }
  | {
      readonly kind: "render";
      readonly bytes: Uint8Array;
      readonly slideIds: readonly number[];
      readonly fonts?: readonly FontFace[];
    }
  | { readonly kind: "font"; readonly path: string };
export type PresentationWorkResult =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | {
      readonly kind: "inspection";
      readonly inspection: Awaited<ReturnType<typeof inspectPresentation>>;
    }
  | ({ readonly kind: "edited" } & Awaited<ReturnType<typeof editPresentation>>)
  | { readonly kind: "rendered"; readonly slides: Awaited<ReturnType<typeof renderPresentation>> }
  | { readonly kind: "font"; readonly info: FontFileInfo };
/** What the worker posts back for one request. */
export type PresentationReply = { readonly id: number } & (
  | { readonly ok: true; readonly result: PresentationWorkResult }
  | { readonly ok: false; readonly code: string; readonly message: string }
);

export interface PresentationRunOptions {
  /** Previews wait behind every queued chat tool call. */
  readonly priority?: "background";
}

const workerSource = "./runtime-worker.ts";
const bundledWorker = "presentation-worker.mjs";
/**
 * The worker source in development. In production, the bundle the build emits
 * beside the server output, found from this module's own location, since the
 * chunk holding it sits at a depth the build decides.
 */
export function presentationWorkerUrl() {
  // A variable, so the build does not mistake the source for an asset to emit.
  if (import.meta.env.DEV) return new URL(workerSource, import.meta.url);
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth++) {
    const candidate = join(directory, bundledWorker);
    if (existsSync(candidate)) return pathToFileURL(candidate);
    directory = dirname(directory);
  }
  throw new PresentationError("worker_unavailable", "The presentation worker bundle is missing.");
}

const failure = (reason: WorkerFailure) => {
  switch (reason.reason) {
    case "closed":
      return new PresentationError("worker_unavailable", "Presentation processing has stopped.");
    case "busy":
      return new PresentationError("busy", "Presentation processing is busy; retry later.");
    case "cancelled":
      return new PresentationError("cancelled", "Presentation processing was cancelled.");
    case "timeout":
      return new PresentationError("timeout", "Presentation processing timed out.");
    case "exited":
      return new PresentationError("worker_exit", `Presentation worker exited (${reason.code}).`);
    case "crashed":
      return new PresentationError("worker_error", "Presentation worker failed.");
  }
};

/** Checks what the parent can before any worker is involved; failures reject like any other. */
function admit(request: PresentationWork) {
  if (request.kind === "create" || request.kind === "font") return;
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
 * The caller supplies a built ESM worker URL; no parser or renderer runs on the
 * caller thread. Workers persist between tasks; a failed or overdue one is replaced.
 */
export function createPresentationRuntime(
  workerUrl: URL | (() => URL),
  options: { readonly workers?: number; readonly timeoutMs?: number } = {},
) {
  const pool = createWorkerPool({
    size: options.workers ?? PRESENTATION_WORKERS.defaultWorkers,
    queue: PRESENTATION_WORKERS.queue,
    // Resolved per worker, so a missing bundle fails the work rather than the server's start.
    spawn: () =>
      new Worker(typeof workerUrl === "function" ? workerUrl() : workerUrl, { execArgv: [] }),
    failure,
  });
  return {
    run(
      request: PresentationWork,
      signal?: AbortSignal,
      runOptions: PresentationRunOptions = {},
    ): Promise<PresentationWorkResult> {
      try {
        admit(request);
      } catch (error) {
        return Promise.reject(error);
      }
      // One copy the worker takes over; the caller's bytes stay untouched.
      const bytes = "bytes" in request ? new Uint8Array(request.bytes) : null;
      return pool.run<PresentationWorkResult>({
        message: bytes ? { ...request, bytes } : request,
        ...(bytes ? { transfer: [bytes.buffer] } : {}),
        timeoutMs: options.timeoutMs ?? PRESENTATION_WORKERS.timeoutMs,
        ...(signal ? { signal } : {}),
        background: runOptions.priority === "background",
        receive: (reply) =>
          reply.ok === true
            ? { ok: true, value: reply.result as PresentationWorkResult }
            : {
                ok: false,
                error: new PresentationError(
                  typeof reply.code === "string" ? reply.code : "worker_error",
                  typeof reply.message === "string" ? reply.message : "Presentation worker failed.",
                ),
              },
      });
    },
    close: () => pool.close(),
  };
}
export type PresentationRuntime = ReturnType<typeof createPresentationRuntime>;

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
      const workers = yield* Config.Int("PRESENTATION_WORKERS").pipe(
        Config.withDefault(PRESENTATION_WORKERS.defaultWorkers),
        Effect.orDie,
      );
      return yield* Effect.acquireRelease(
        Effect.sync(() =>
          createPresentationRuntime(presentationWorkerUrl, {
            workers: Math.max(1, Math.min(PRESENTATION_WORKERS.maxWorkers, workers)),
          }),
        ),
        (runtime) => Effect.promise(() => runtime.close()),
      );
    }),
  );
}
