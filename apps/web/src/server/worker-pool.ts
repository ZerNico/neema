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
 * no longer known. Workers start on demand and stop after a while idle, giving
 * back the memory their largest job left them holding.
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
  /** Active execution limit, starting at dispatch. */
  readonly timeoutMs: number;
  /** Optional wall-clock deadline including the wait in either lane. */
  readonly deadline?: number;
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
  /** How long a worker may sit without a job before it is stopped. */
  readonly idleMs?: number;
}

type Pending = WorkerJob<unknown> & {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
};
type Slot = {
  readonly worker: PoolWorker;
  job: Pending | null;
  dead: boolean;
  idle?: ReturnType<typeof setTimeout>;
};

const IDLE_MS = 60_000;

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

export function createWorkerPool(options: WorkerPoolOptions) {
  const slots: Slot[] = [];
  const retiring = new Set<Promise<unknown>>();
  const lanes = { foreground: [] as Pending[], background: [] as Pending[] };
  let nextId = 1;
  let closed = false;

  const settle = (job: Pending, result: Settlement<unknown>) => {
    if (job.timer) clearTimeout(job.timer);
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
    if (result.ok) job.resolve(result.value);
    else job.reject(result.error);
  };
  const retire = (slot: Slot, failure: WorkerFailure | null) => {
    if (slot.dead) return;
    slot.dead = true;
    if (slot.idle) clearTimeout(slot.idle);
    slots.splice(slots.indexOf(slot), 1);
    const job = slot.job;
    slot.job = null;
    // Removing a slot permits replacement, but shutdown still owns its termination.
    const stopped = slot.worker.terminate();
    retiring.add(stopped);
    void stopped.then(
      () => retiring.delete(stopped),
      () => retiring.delete(stopped),
    );
    if (job && failure) settle(job, { ok: false, error: options.failure(failure) });
    pump();
  };
  /** Stops a worker left without a job once it has waited `idleMs`. */
  const idleAfterJob = (slot: Slot) => {
    if (slot.dead || slot.job) return;
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = setTimeout(() => {
      if (!slot.job) retire(slot, null);
    }, options.idleMs ?? IDLE_MS);
    slot.idle.unref?.();
  };
  const spawn = () => {
    const slot: Slot = { worker: options.spawn(), job: null, dead: false };
    slots.push(slot);
    slot.worker.on("message", (reply: WorkerReply) => {
      const job = slot.job;
      if (!job || slot.dead || reply?.id !== job.id || expire(job)) return;
      const post: Post = (message, transfer = []) => {
        // The job may have ended (deadline, cancel) while its caller prepared an answer.
        if (slot.dead || slot.job !== job || expire(job)) return;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker ports do not accept target origins.
        slot.worker.postMessage(message, [...transfer]);
      };
      let result: Settlement<unknown> | undefined;
      try {
        result = job.receive(reply, post);
      } catch (error) {
        result = { ok: false, error: asError(error) };
      }
      if (slot.dead || slot.job !== job || expire(job) || !result) return;
      slot.job = null;
      settle(job, result);
      pump();
      idleAfterJob(slot);
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
      if (job.deadline !== undefined && job.deadline <= Date.now()) {
        settle(job, {
          ok: false,
          error: options.failure({ reason: "timeout", timeoutMs: job.timeoutMs }),
        });
        continue;
      }
      try {
        slot ??= spawn();
      } catch (cause) {
        settle(job, {
          ok: false,
          error: options.failure({ reason: "crashed", cause: asError(cause) }),
        });
        continue;
      }
      const remaining =
        job.deadline === undefined
          ? job.timeoutMs
          : Math.min(job.timeoutMs, job.deadline - Date.now());
      if (remaining <= 0) {
        settle(job, {
          ok: false,
          error: options.failure({ reason: "timeout", timeoutMs: job.timeoutMs }),
        });
        continue;
      }
      slot.job = job;
      if (slot.idle) clearTimeout(slot.idle);
      if (job.timer) clearTimeout(job.timer);
      job.timer = setTimeout(
        () => fail(job, { reason: "timeout", timeoutMs: job.timeoutMs }),
        remaining,
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
  const fail = (job: Pending, failure: WorkerFailure) => {
    for (const lane of [lanes.foreground, lanes.background]) {
      const index = lane.indexOf(job);
      if (index >= 0) {
        lane.splice(index, 1);
        settle(job, { ok: false, error: options.failure(failure) });
        return;
      }
    }
    const slot = slots.find((item) => item.job === job);
    if (slot) retire(slot, failure);
  };
  const expire = (job: Pending) => {
    // Timer delivery can lag behind a worker reply or an asynchronously prepared response.
    if (job.deadline === undefined || job.deadline > Date.now()) return false;
    fail(job, { reason: "timeout", timeoutMs: job.timeoutMs });
    return true;
  };

  return {
    run<T>(job: WorkerJob<T>): Promise<T> {
      if (closed) return Promise.reject(options.failure({ reason: "closed" }));
      if (job.signal?.aborted) return Promise.reject(options.failure({ reason: "cancelled" }));
      if (job.deadline !== undefined && job.deadline <= Date.now())
        return Promise.reject(options.failure({ reason: "timeout", timeoutMs: job.timeoutMs }));
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
          pending.abort = () => fail(pending, { reason: "cancelled" });
          job.signal.addEventListener("abort", pending.abort, { once: true });
        }
        lane.push(pending);
        if (job.deadline !== undefined)
          pending.timer = setTimeout(
            () => fail(pending, { reason: "timeout", timeoutMs: pending.timeoutMs }),
            job.deadline - Date.now(),
          );
        pump();
      });
    },
    async close() {
      closed = true;
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- refuse reads options from the enclosing pool
      const refuse = (job: Pending) =>
        settle(job, { ok: false, error: options.failure({ reason: "closed" }) });
      for (const job of [...lanes.foreground.splice(0), ...lanes.background.splice(0)]) refuse(job);
      await Promise.allSettled([
        ...retiring,
        ...slots.splice(0).map((slot) => {
          slot.dead = true;
          if (slot.job) refuse(slot.job);
          slot.job = null;
          return slot.worker.terminate();
        }),
      ]);
    },
  };
}
export type WorkerPool = ReturnType<typeof createWorkerPool>;
