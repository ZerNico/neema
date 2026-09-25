import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { Config, Context, Effect, Layer } from "effect";
import workerSource from "virtual:custom-tool-runtime-worker";
import { CustomToolCompileFailed } from "../errors.ts";
import { CUSTOM_TOOL_LIMITS, type CustomToolFunctionManifest } from "../schema.ts";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerRunFile,
  WorkerRunResult,
} from "./runtime-worker.ts";

export type CustomToolRunFile = WorkerRunFile;

export interface CustomToolRunResult {
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly logs: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<CustomToolRunFile>;
  readonly durationMs: number;
}

type PoolRequest =
  | Omit<Extract<WorkerRequest, { readonly type: "inspect" }>, "id">
  | Omit<Extract<WorkerRequest, { readonly type: "invoke" }>, "id">;

/** A file a tool may read: bytes the host checked the sender may use. */
export interface ResolvedToolFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}
type FileLookup = (reference: string) => Promise<ResolvedToolFile>;

interface PendingJob<T> {
  readonly id: number;
  readonly request: PoolRequest;
  readonly resolveFile?: FileLookup | undefined;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

interface WorkerSlot {
  readonly worker: Worker;
  busy: PendingJob<unknown> | undefined;
  dead: boolean;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const runtimeUrl = JSON.stringify(import.meta.url);
const workerEntry = `__filename = require("node:url").fileURLToPath(${runtimeUrl});
require = require("node:module").createRequire(${runtimeUrl});
${workerSource}`;

const abortError = () => new Error("The custom tool job was cancelled.");

class WorkerPool {
  readonly #slots: WorkerSlot[] = [];
  readonly #queue: Array<PendingJob<unknown>> = [];
  #nextId = 1;
  #closed = false;

  constructor(readonly size: number) {
    for (let index = 0; index < size; index += 1) this.#spawn();
  }

  submit<T>(
    request: PoolRequest,
    timeoutMs: number,
    signal: AbortSignal,
    resolveFile?: FileLookup,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("The custom tool runtime is closed."));
    return new Promise<T>((resolve, reject) => {
      const job: PendingJob<T> = {
        id: this.#nextId++,
        request,
        resolveFile,
        timeoutMs,
        signal,
        resolve,
        reject,
      };
      job.abort = () => this.#cancel(job as PendingJob<unknown>);
      signal.addEventListener("abort", job.abort, { once: true });
      this.#queue.push(job as PendingJob<unknown>);
      this.#pump();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const cause = new Error("The custom tool runtime is closing.");
    for (const job of this.#queue.splice(0)) this.#finish(job, cause);
    const terminations = this.#slots.map((slot) => {
      slot.dead = true;
      if (slot.busy) this.#finish(slot.busy, cause);
      return slot.worker.terminate();
    });
    await Promise.allSettled(terminations);
    this.#slots.length = 0;
  }

  #spawn(): void {
    if (this.#closed) return;
    const worker = new Worker(workerEntry, { eval: true });
    const slot: WorkerSlot = { worker, busy: undefined, dead: false };
    this.#slots.push(slot);
    worker.on("message", (response: WorkerResponse) => this.#complete(slot, response));
    worker.on("error", (cause) =>
      this.#replace(slot, cause instanceof Error ? cause : new Error(String(cause))),
    );
    // Any exit we did not ask for loses the slot, code 0 included: tool code
    // can call process.exit(0), and its job would otherwise wait out the full
    // deadline on a thread that no longer exists.
    worker.on("exit", (code) => {
      if (!slot.dead) {
        this.#replace(slot, new Error(`The custom tool worker exited with code ${code}.`));
      }
    });
  }

  #pump(): void {
    for (const slot of this.#slots) {
      if (slot.dead || slot.busy || this.#queue.length === 0) continue;
      const job = this.#queue.shift()!;
      if (job.signal.aborted) {
        this.#finish(job, abortError());
        continue;
      }
      slot.busy = job;
      job.timer = setTimeout(() => {
        this.#replace(
          slot,
          new Error(
            `The custom tool did not finish within ${Math.round(job.timeoutMs / 1000)} seconds.`,
          ),
        );
      }, job.timeoutMs);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker ports do not accept target origins.
      slot.worker.postMessage({ ...job.request, id: job.id } satisfies WorkerRequest);
    }
  }

  #complete(slot: WorkerSlot, response: WorkerResponse): void {
    const job = slot.busy;
    if (!job || response.id !== job.id) return;
    if ("type" in response) {
      this.#answerFile(slot, job, response.requestId, response.reference);
      return;
    }
    slot.busy = undefined;
    if (response.ok) this.#finish(job, undefined, response.value);
    else this.#finish(job, new Error(response.error));
    this.#pump();
  }

  /** Runs while the job's deadline keeps ticking; a slow lookup counts against it. */
  #answerFile(slot: WorkerSlot, job: PendingJob<unknown>, requestId: number, reference: string) {
    const reply = (message: WorkerRequest, transfer: ArrayBuffer[] = []) => {
      // The job may have ended (deadline, cancel) while the lookup ran.
      if (slot.dead || slot.busy !== job) return;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker ports do not accept target origins.
      slot.worker.postMessage(message, transfer);
    };
    const lookup =
      job.resolveFile ?? (() => Promise.reject(new Error("Files are not available here.")));
    lookup(reference).then(
      (file) => {
        // A fresh buffer: a pooled Buffer's memory must never be transferred away.
        const bytes = new Uint8Array(file.bytes);
        reply(
          { type: "file", requestId, file: { name: file.name, mediaType: file.mediaType, bytes } },
          [bytes.buffer],
        );
      },
      (cause: unknown) => reply({ type: "file", requestId, error: errorMessage(cause) }),
    );
  }

  #cancel(job: PendingJob<unknown>): void {
    const queuedIndex = this.#queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.#queue.splice(queuedIndex, 1);
      this.#finish(job, abortError());
      return;
    }
    const slot = this.#slots.find((candidate) => candidate.busy === job);
    if (slot) this.#replace(slot, abortError());
  }

  #replace(slot: WorkerSlot, cause: Error): void {
    if (slot.dead) return;
    slot.dead = true;
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);
    if (slot.busy) {
      const job = slot.busy;
      slot.busy = undefined;
      this.#finish(job, cause);
    }
    void slot.worker.terminate();
    this.#spawn();
    this.#pump();
  }

  #finish(
    job: PendingJob<unknown>,
    cause?: Error,
    value?: ReadonlyArray<CustomToolFunctionManifest> | WorkerRunResult,
  ): void {
    if (job.timer) clearTimeout(job.timer);
    if (job.abort) job.signal.removeEventListener("abort", job.abort);
    if (cause) job.reject(cause);
    else job.resolve(value);
  }
}

const artifactHash = (compiled: string): string =>
  createHash("sha256").update(compiled).digest("hex");

const clamp = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export class CustomToolRuntime extends Context.Service<
  CustomToolRuntime,
  {
    inspect(input: {
      readonly compiled: string;
      readonly slug: string;
      readonly timeoutMs?: number;
    }): Effect.Effect<ReadonlyArray<CustomToolFunctionManifest>, CustomToolCompileFailed>;
    run(input: {
      readonly compiled: string;
      readonly functionKey: string;
      readonly args: unknown;
      readonly timeoutMs: number;
      readonly captureLogs?: boolean;
      /** Resolves a file parameter; failing with a sentence the model can act on. */
      readonly resolveFile?: (reference: string) => Effect.Effect<ResolvedToolFile, string>;
    }): Effect.Effect<CustomToolRunResult>;
  }
>()("chat/custom-tools/CustomToolRuntime") {
  static readonly layer = Layer.effect(
    CustomToolRuntime,
    Effect.gen(function* () {
      const configuredSize = yield* Config.Int("CUSTOM_TOOL_WORKERS").pipe(
        Config.withDefault(2),
        Effect.orDie,
      );
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new WorkerPool(Math.max(1, Math.min(8, configuredSize)))),
        (runtimePool) => Effect.promise(() => runtimePool.close()),
      );

      const inspect = Effect.fn("CustomToolRuntime.inspect")(function* (input: {
        readonly compiled: string;
        readonly slug: string;
        readonly timeoutMs?: number;
      }) {
        return yield* Effect.tryPromise({
          try: (signal) =>
            pool.submit<ReadonlyArray<CustomToolFunctionManifest>>(
              {
                type: "inspect",
                artifactHash: artifactHash(input.compiled),
                compiled: input.compiled,
                slug: input.slug,
              },
              input.timeoutMs ?? CUSTOM_TOOL_LIMITS.buildTimeoutMs,
              signal,
            ),
          catch: (cause) => new CustomToolCompileFailed({ message: errorMessage(cause) }),
        });
      });

      const run = Effect.fn("CustomToolRuntime.run")(function* (input: {
        readonly compiled: string;
        readonly functionKey: string;
        readonly args: unknown;
        readonly timeoutMs: number;
        readonly captureLogs?: boolean;
        readonly resolveFile?: (reference: string) => Effect.Effect<ResolvedToolFile, string>;
      }) {
        const started = Date.now();
        const resolveFile = input.resolveFile;
        const context = yield* Effect.context<never>();
        const lookup: FileLookup | undefined = resolveFile
          ? (reference) =>
              Effect.runPromiseWith(context)(
                resolveFile(reference).pipe(Effect.mapError((reason) => new Error(reason))),
              )
          : undefined;
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            pool.submit<WorkerRunResult>(
              {
                type: "invoke",
                artifactHash: artifactHash(input.compiled),
                compiled: input.compiled,
                functionKey: input.functionKey,
                args: input.args,
                captureLogs: input.captureLogs ?? false,
              },
              input.timeoutMs,
              signal,
              lookup,
            ),
          catch: errorMessage,
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false, error, logs: [] as ReadonlyArray<string> }),
            onSuccess: (value) => value,
          }),
        );
        return {
          ...result,
          ...(result.error ? { error: clamp(result.error, CUSTOM_TOOL_LIMITS.errorChars) } : {}),
          durationMs: Date.now() - started,
        } satisfies CustomToolRunResult;
      });

      return CustomToolRuntime.of({ inspect, run });
    }),
  );
}
