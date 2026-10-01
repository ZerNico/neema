import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Config, Effect } from "effect";
import { JobError, type JobHandlers } from "./job-worker.ts";
import { createOwnerLimit } from "./owner-limit.ts";
import { createWorkerPool, type PoolWorker, type WorkerFailure } from "./worker-pool.ts";
import { forkWorker } from "./worker-process.ts";

export { JobError } from "./job-worker.ts";

type RequestOf<H, K extends keyof H> = H[K] extends (request: infer R) => unknown ? R : never;
/** Every request a worker's handlers take: `kind` names the handler. */
export type JobRequest<H extends JobHandlers> = {
  [K in keyof H & string]: { readonly kind: K } & RequestOf<H, K>;
}[keyof H & string];
/** What the handler for `K` resolves to. */
export type JobResult<H extends JobHandlers, K extends keyof H> = Awaited<ReturnType<H[K]>>;

export interface JobRunOptions {
  /** Previews wait behind every queued chat tool call. */
  readonly priority?: "background";
  /** Whose work this is: one person's jobs beyond `perOwner` wait for their own. */
  readonly owner?: string;
}

export interface JobRuntime<H extends JobHandlers, O extends JobRunOptions = JobRunOptions> {
  run<R extends JobRequest<H>>(
    request: R,
    signal?: AbortSignal,
    options?: O,
  ): Promise<JobResult<H, R["kind"]>>;
  close(): Promise<void>;
}

/**
 * The source in development, else the bundle the build emits beside the server
 * output, found by walking up from `base` (the caller's `import.meta.url`),
 * since the chunk holding the caller sits at a depth the build decides.
 */
export function workerEntry(base: string, source: string, bundle: string): () => URL {
  return () => {
    // A variable, so the build does not mistake the source for an asset to emit.
    if (import.meta.env.DEV) return new URL(source, base);
    let directory = dirname(fileURLToPath(base));
    for (let depth = 0; depth < 4; depth++) {
      const candidate = join(directory, bundle);
      if (existsSync(candidate)) return pathToFileURL(candidate);
      directory = dirname(directory);
    }
    throw new JobError("worker_unavailable", `The ${bundle} worker bundle is missing.`);
  };
}

/**
 * Jobs for one worker module, each in a killable worker process: a pool, a
 * per-person limit, and typed requests. `admit` checks what the parent can
 * before any worker is involved; `errorOf` gives failures the family's error.
 */
export function createJobRuntime<H extends JobHandlers>(options: {
  readonly entry: URL | (() => URL);
  /** "Presentation processing": the subject of every failure message. */
  readonly label: string;
  readonly workers: number;
  readonly queue: number;
  readonly timeoutMs: number;
  readonly heapMb: number;
  readonly perOwner: number;
  readonly errorOf: (code: string, message: string) => JobError;
  readonly admit?: (request: JobRequest<H>) => void;
  /** A thread instead of a process: only tests, which exercise the jobs, not containment. */
  readonly spawn?: (url: URL) => PoolWorker;
}): JobRuntime<H> {
  const { label, errorOf } = options;
  const failure = (reason: WorkerFailure) => {
    switch (reason.reason) {
      case "closed":
        return errorOf("worker_unavailable", `${label} has stopped.`);
      case "busy":
        return errorOf("busy", `${label} is busy; retry later.`);
      case "cancelled":
        return errorOf("cancelled", `${label} was cancelled.`);
      case "timeout":
        return errorOf("timeout", `${label} timed out.`);
      case "exited":
        return errorOf("worker_exit", `${label} stopped unexpectedly (${reason.code}).`);
      case "crashed":
        return errorOf("worker_error", `${label} failed.`);
    }
  };
  const pool = createWorkerPool({
    size: options.workers,
    queue: options.queue,
    // Resolved per worker, so a missing bundle fails the work rather than the server's start.
    spawn: () => {
      const url = typeof options.entry === "function" ? options.entry() : options.entry;
      return options.spawn?.(url) ?? forkWorker(url, { heapMb: options.heapMb });
    },
    failure,
  });
  const owners = createOwnerLimit({
    perOwner: options.perOwner,
    queue: options.queue,
    busy: () => failure({ reason: "busy" }),
    cancelled: () => failure({ reason: "cancelled" }),
  });
  const work = (
    request: JobRequest<H>,
    signal: AbortSignal | undefined,
    runOptions: JobRunOptions,
  ) => {
    // One copy of each top-level buffer the worker takes over; the caller's stay untouched.
    const transfer: ArrayBuffer[] = [];
    const message = Object.fromEntries(
      Object.entries(request as Record<string, unknown>).map(([key, value]) => {
        if (!(value instanceof Uint8Array)) return [key, value];
        const copy = new Uint8Array(value);
        transfer.push(copy.buffer);
        return [key, copy];
      }),
    );
    return pool.run<unknown>({
      message,
      transfer,
      timeoutMs: options.timeoutMs,
      ...(signal ? { signal } : {}),
      background: runOptions.priority === "background",
      // A reply crosses a process boundary, so it is read, not trusted.
      receive: (reply) =>
        reply.ok === true
          ? { ok: true, value: reply.result }
          : {
              ok: false,
              error: errorOf(
                typeof reply.code === "string" ? reply.code : "worker_error",
                typeof reply.message === "string" ? reply.message : `${label} failed.`,
              ),
            },
    });
  };
  return {
    async run(request, signal, runOptions = {}) {
      options.admit?.(request);
      return owners.run(runOptions.owner, signal, () => work(request, signal, runOptions)) as never;
    },
    close: () => pool.close(),
  };
}

/** The worker count from its environment variable, bounded. */
export const workerCount = (name: string, fallback: number, max: number) =>
  Config.Int(name).pipe(
    Config.withDefault(fallback),
    Effect.orDie,
    Effect.map((count) => Math.max(1, Math.min(max, count))),
  );

/**
 * The same runtime with options every call gets, such as whose job it is;
 * `extra` may be async (loading fonts) and wins over what the caller passed.
 */
export function withRunOptions<H extends JobHandlers, O extends JobRunOptions>(
  runtime: JobRuntime<H, O>,
  extra: (request: JobRequest<H>, options: O | undefined) => Partial<O> | Promise<Partial<O>>,
): JobRuntime<H, O> {
  return {
    close: () => runtime.close(),
    async run<R extends JobRequest<H>>(
      request: R,
      signal?: AbortSignal,
      options?: O,
    ): Promise<JobResult<H, R["kind"]>> {
      return runtime.run(request, signal, { ...options, ...(await extra(request, options)) } as O);
    },
  };
}
