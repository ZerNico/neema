import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { Config, Context, Effect, Layer } from "effect";
import workerSource from "virtual:custom-tool-runtime-worker";
import { createWorkerPool, type WorkerFailure } from "~/server/worker-pool.ts";
import { CustomToolCompileFailed } from "../errors.ts";
import { CUSTOM_TOOL_LIMITS, type CustomToolFunctionManifest } from "../schema.ts";
import type { FileRef } from "../authoring.ts";
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
  readonly ref: FileRef;
}
type FileLookup = (reference: string) => Promise<ResolvedToolFile>;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const runtimeUrl = JSON.stringify(import.meta.url);
const workerEntry = `__filename = require("node:url").fileURLToPath(${runtimeUrl});
require = require("node:module").createRequire(${runtimeUrl});
${workerSource}`;

const failure = (reason: WorkerFailure) => {
  switch (reason.reason) {
    case "closed":
    case "busy":
      return new Error("The custom tool runtime is closed.");
    case "cancelled":
      return new Error("The custom tool job was cancelled.");
    case "timeout":
      return new Error(
        `The custom tool did not finish within ${Math.round(reason.timeoutMs / 1000)} seconds.`,
      );
    case "exited":
      return new Error(`The custom tool worker exited with code ${reason.code}.`);
    case "crashed":
      return reason.cause;
  }
};

const createPool = (size: number) => {
  const pool = createWorkerPool({
    size,
    // Tool calls are bounded by the attempt, not by a queue.
    queue: Number.POSITIVE_INFINITY,
    spawn: () => new Worker(workerEntry, { eval: true }),
    failure,
  });
  const submit = <T>(
    request: PoolRequest,
    timeoutMs: number,
    signal: AbortSignal,
    resolveFile?: FileLookup,
  ) =>
    pool.run<T>({
      message: request,
      timeoutMs,
      signal,
      receive: (reply, post) => {
        const response = reply as WorkerResponse;
        if ("type" in response) {
          // Runs while the job's deadline keeps ticking; a slow lookup counts against it.
          const lookup =
            resolveFile ?? (() => Promise.reject(new Error("Files are not available here.")));
          lookup(response.reference).then(
            (file) => {
              // A fresh buffer: a pooled Buffer's memory must never be transferred away.
              const bytes = new Uint8Array(file.bytes);
              post(
                {
                  type: "file",
                  requestId: response.requestId,
                  file: { name: file.name, mediaType: file.mediaType, bytes, ref: file.ref },
                } satisfies WorkerRequest,
                [bytes.buffer],
              );
            },
            (cause: unknown) =>
              post({
                type: "file",
                requestId: response.requestId,
                error: errorMessage(cause),
              } satisfies WorkerRequest),
          );
          return undefined;
        }
        return response.ok
          ? { ok: true, value: response.value as T }
          : { ok: false, error: new Error(response.error) };
      },
    });
  return { submit, close: pool.close };
};

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
        Effect.sync(() => createPool(Math.max(1, Math.min(8, configuredSize)))),
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
