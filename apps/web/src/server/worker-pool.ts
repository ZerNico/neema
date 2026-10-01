/**
 * What the pool drives: a worker thread, or a process (`worker-process.ts`)
 * when a timeout must stop native code too.
 */
export interface PoolWorker {
  on(event: "message", listener: (reply: WorkerReply) => void): unknown;
  on(event: "error", listener: (cause: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  terminate(): Promise<unknown>;
}

/**
 * Persistent workers for work that must not run on the server's own thread. A
 * job owns one worker until it settles. A worker that times out, is cancelled
 * mid-job, crashes or exits is replaced rather than reused, since its state is
 * no longer known. Workers start on demand.
 */
export type WorkerFailure =
  | { readonly reason: "closed" }
  | { readonly reason: "busy" }
  | { readonly reason: "cancelled" }
  | { readonly reason: "timeout"; readonly timeoutMs: number }
  | { readonly reason: "exited"; readonly code: number }
  | { readonly reason: "crashed"; readonly cause: Error };

/** A message from a worker, addressed to the job by the `id` the pool gave it. */
export type WorkerReply = { readonly id: number } & Record<string, unknown>;
export type Settlement<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };
type Post = (message: object, transfer?: readonly ArrayBuffer[]) => void;

export interface WorkerJob<T> {
  /** Posted with the job's `id` added. */
  readonly message: object;
  /** Buffers moved to the worker rather than copied; the caller must not use them again. */
  readonly transfer?: readonly ArrayBuffer[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Background jobs wait behind every queued foreground job. */
  readonly background?: boolean;
  /** Handles one reply: a settlement ends the job; undefined keeps it running. `post` answers the worker. */
  readonly receive: (reply: WorkerReply, post: Post) => Settlement<T> | undefined;
}

export interface WorkerPoolOptions {
  readonly size: number;
  /** Jobs each lane may hold waiting before new ones are refused as busy. */
  readonly queue: number;
  readonly spawn: () => PoolWorker;
  /** The error a job rejects with when the pool, not the worker, ends it. */
  readonly failure: (failure: WorkerFailure) => Error;
}

type Pending = WorkerJob<unknown> & {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
};
type Slot = { readonly worker: PoolWorker; job: Pending | null; dead: boolean };

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

export function createWorkerPool(options: WorkerPoolOptions) {
  const slots: Slot[] = [];
  const lanes = { foreground: [] as Pending[], background: [] as Pending[] };
  let nextId = 1;
  let closed = false;

  const settle = (job: Pending, result: Settlement<unknown>) => {
    if (job.timer) clearTimeout(job.timer);
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
    if (result.ok) job.resolve(result.value);
    else job.reject(result.error);
  };
  const retire = (slot: Slot, failure: WorkerFailure) => {
    if (slot.dead) return;
    slot.dead = true;
    slots.splice(slots.indexOf(slot), 1);
    const job = slot.job;
    slot.job = null;
    void slot.worker.terminate();
    if (job) settle(job, { ok: false, error: options.failure(failure) });
    pump();
  };
  const spawn = () => {
    const slot: Slot = { worker: options.spawn(), job: null, dead: false };
    slots.push(slot);
    slot.worker.on("message", (reply: WorkerReply) => {
      const job = slot.job;
      if (!job || reply?.id !== job.id) return;
      const post: Post = (message, transfer = []) => {
        // The job may have ended (deadline, cancel) while its caller prepared an answer.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker ports do not accept target origins.
        if (!slot.dead && slot.job === job) slot.worker.postMessage(message, [...transfer]);
      };
      let result: Settlement<unknown> | undefined;
      try {
        result = job.receive(reply, post);
      } catch (error) {
        result = { ok: false, error: asError(error) };
      }
      if (!result) return;
      slot.job = null;
      settle(job, result);
      pump();
    });
    slot.worker.on("error", (cause) =>
      retire(slot, {
        reason: "crashed",
        cause: asError(cause),
      }),
    );
    // Any exit the pool did not ask for loses the slot, code 0 included: code
    // can call process.exit(0), and its job would otherwise wait out its deadline.
    slot.worker.on("exit", (code) => retire(slot, { reason: "exited", code }));
    return slot;
  };
  const pump = () => {
    if (closed) return;
    while (lanes.foreground.length || lanes.background.length) {
      let slot = slots.find((item) => !item.dead && !item.job);
      if (!slot && slots.length >= options.size) return;
      const job = (lanes.foreground.length ? lanes.foreground : lanes.background).shift()!;
      try {
        slot ??= spawn();
      } catch (cause) {
        settle(job, {
          ok: false,
          error: options.failure({ reason: "crashed", cause: asError(cause) }),
        });
        continue;
      }
      slot.job = job;
      job.timer = setTimeout(
        () => retire(slot, { reason: "timeout", timeoutMs: job.timeoutMs }),
        job.timeoutMs,
      );
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker ports do not accept target origins.
        slot.worker.postMessage({ ...job.message, id: job.id }, [...(job.transfer ?? [])]);
      } catch (error) {
        slot.job = null;
        settle(job, {
          ok: false,
          error: asError(error),
        });
      }
    }
  };
  const cancel = (job: Pending) => {
    for (const lane of [lanes.foreground, lanes.background]) {
      const index = lane.indexOf(job);
      if (index >= 0) {
        lane.splice(index, 1);
        settle(job, { ok: false, error: options.failure({ reason: "cancelled" }) });
        return;
      }
    }
    const slot = slots.find((item) => item.job === job);
    if (slot) retire(slot, { reason: "cancelled" });
  };

  return {
    run<T>(job: WorkerJob<T>): Promise<T> {
      if (closed) return Promise.reject(options.failure({ reason: "closed" }));
      if (job.signal?.aborted) return Promise.reject(options.failure({ reason: "cancelled" }));
      const lane = job.background ? lanes.background : lanes.foreground;
      if (lane.length >= options.queue) return Promise.reject(options.failure({ reason: "busy" }));
      return new Promise<T>((resolve, reject) => {
        const pending: Pending = {
          ...(job as WorkerJob<unknown>),
          id: nextId++,
          resolve: resolve as (value: unknown) => void,
          reject,
        };
        if (job.signal) {
          pending.abort = () => cancel(pending);
          job.signal.addEventListener("abort", pending.abort, { once: true });
        }
        lane.push(pending);
        pump();
      });
    },
    async close() {
      closed = true;
      const refuse = (job: Pending) =>
        settle(job, { ok: false, error: options.failure({ reason: "closed" }) });
      for (const job of [...lanes.foreground.splice(0), ...lanes.background.splice(0)]) refuse(job);
      await Promise.allSettled(
        slots.splice(0).map((slot) => {
          slot.dead = true;
          if (slot.job) refuse(slot.job);
          slot.job = null;
          return slot.worker.terminate();
        }),
      );
    },
  };
}
export type WorkerPool = ReturnType<typeof createWorkerPool>;
