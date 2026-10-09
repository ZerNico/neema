// The page's side of the ui-block Worker. One Worker per page; a request
// that stays executing past the watchdog terminates it, and every block
// re-renders from its source and last state in a fresh one. Queue time does
// not count: the Worker reports when a request starts.

import type { CallReply, CallRequest, RenderReply, RenderRequest } from "./engine.ts";
import type { WorkerMessage, WorkerRequest } from "./protocol.ts";

const WATCHDOG_MS = 1000;
/** A block that took the Worker down this often stays frozen at its last tree. */
const FREEZE_AFTER = 2;

export type Unavailable = {
  readonly ok: false;
  readonly reason: "unavailable";
  readonly error: string;
};

export interface GenuiClient {
  render(request: RenderRequest): Promise<RenderReply | Unavailable>;
  call(request: CallRequest): Promise<CallReply | Unavailable>;
  release(block: string): void;
  /** Increments each time the Worker is replaced; older handler references are stale. */
  epoch(): number;
  subscribe(listener: () => void): () => void;
}

interface Pending {
  readonly block: string | null;
  readonly resolve: (reply: RenderReply | CallReply | Unavailable | null) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const unavailable = (error: string): Unavailable => ({ ok: false, reason: "unavailable", error });

/** Render replies carry a tree or a reason; call replies carry actions or staleness. */
function isRenderReply(
  reply: RenderReply | CallReply | Unavailable,
): reply is RenderReply | Unavailable {
  return "nodes" in reply || "reason" in reply;
}

export function createWorkerClient(spawn: () => Worker): GenuiClient & {
  /** Starts the Worker, and with it QuickJS, before any block asks. */
  warm(): void;
} {
  let worker: Worker | null = null;
  let generation = 0;
  let nextId = 1;
  let fatal: string | null = null;
  const pending = new Map<number, Pending>();
  const crashes = new Map<string, number>();
  const listeners = new Set<() => void>();

  const settleAll = (error: string) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(unavailable(error));
    }
    pending.clear();
  };

  const restart = (culprit: string | null) => {
    if (culprit) crashes.set(culprit, (crashes.get(culprit) ?? 0) + 1);
    worker?.terminate();
    worker = null;
    generation += 1;
    settleAll("restarted");
    for (const listener of listeners) listener();
  };

  const onMessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if ("fatal" in message) {
      fatal = message.fatal;
      settleAll(message.fatal);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    if ("started" in message) {
      entry.timer = setTimeout(() => restart(entry.block), WATCHDOG_MS);
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(message.id);
    entry.resolve(message.reply);
  };

  const ensure = (): Worker => {
    if (worker) return worker;
    const next = spawn();
    next.addEventListener("message", onMessage);
    // An error event means the Worker itself broke (failed to load, or threw
    // outside a request); requests in flight cannot complete.
    next.addEventListener("error", () => restart(null));
    worker = next;
    return next;
  };

  const send = (request: WorkerRequest, block: string | null) =>
    new Promise<RenderReply | CallReply | Unavailable | null>((resolve) => {
      if (fatal) return resolve(unavailable(fatal));
      if (block && (crashes.get(block) ?? 0) >= FREEZE_AFTER)
        return resolve(unavailable("stopped_responding"));
      pending.set(request.id, { block, resolve });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage takes no origin
      ensure().postMessage(request);
    });

  return {
    async render(request) {
      const reply = await send({ id: nextId++, op: "render", request }, request.block);
      return reply && isRenderReply(reply) ? reply : unavailable("no_reply");
    },
    async call(request) {
      const reply = await send({ id: nextId++, op: "call", request }, request.block);
      return reply && !isRenderReply(reply) ? reply : unavailable("no_reply");
    },
    release(block) {
      if (!worker) return;
      void send({ id: nextId++, op: "release", block }, null);
    },
    warm() {
      if (!fatal) ensure();
    },
    epoch: () => generation,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared: ReturnType<typeof createWorkerClient> | null = null;

const sharedWorker = () =>
  (shared ??= createWorkerClient(
    () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  ));

/** The page's Worker client, created on the first ui block. Browser only. */
export function sharedWorkerClient(): GenuiClient {
  return sharedWorker();
}

/** Creates the page's Worker now, so QuickJS is loading before the first block mounts. */
export function warmSharedWorker(): void {
  sharedWorker().warm();
}
