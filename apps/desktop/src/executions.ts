import { randomUUID } from "node:crypto";
import { refusalReply, type BridgeReply } from "@chat/desktop-rpc";

/** Calls the model makes, keyed by the server's call id. Anything else runs as asked. */
const MODEL_OPERATIONS = new Set([
  "listDirectory",
  "readFile",
  "readBinary",
  "writeFile",
  "saveToWorkspace",
  "editFile",
  "movePath",
  "deletePath",
  "findFiles",
  "searchFiles",
  "runCommand",
  "requestNetworkAccess",
  "requestPathAccess",
  "requestLocalAccess",
]);

/** Operations whose result must be kept for a while: running them twice is a second edit. */
const SIDE_EFFECTS = new Set([
  "writeFile",
  "saveToWorkspace",
  "editFile",
  "movePath",
  "deletePath",
  "runCommand",
  "requestNetworkAccess",
  "requestPathAccess",
  "requestLocalAccess",
]);

// Workspace staging, promotion, cloning, grants, and cleanup deliberately stay
// out of both sets: they are user actions like chooseFolder, so they carry no
// callId or model-operation ledger entry.

interface Entry {
  readonly callId: string;
  readonly controller: AbortController;
  promise: Promise<BridgeReply>;
  completedAt?: number;
}

const cancelled = () => refusalReply("failed", "This desktop call was cancelled.");

/**
 * Joins a renderer that reloaded mid-call onto the work its predecessor
 * started, so a page refresh never runs a write or a command twice.
 *
 * In-flight calls are shared by call id. A finished side effect is retained
 * for as long as the server would still accept its result, so a late replay
 * gets the answer instead of a second execution; a finished read is dropped
 * at once, since reading twice costs nothing and its result may be large.
 * A cancellation is remembered for the same window, so a request that
 * arrives after its Stop is refused rather than started.
 */
export const makeExecutions = (
  run: (tag: string, payload: unknown, signal: AbortSignal) => Promise<BridgeReply>,
  options: { now?: () => number; retentionMs?: number } = {},
) => {
  const id = randomUUID();
  const entries = new Map<string, Entry>();
  const cancellations = new Map<string, number>();
  const now = options.now ?? Date.now;
  // The server waits at most ten minutes for a command; a replay after that
  // meets a handler that has already given up, so keeping more buys nothing.
  const retentionMs = options.retentionMs ?? 10 * 60 * 1_000;
  let closed = false;

  const prune = () => {
    const cutoff = now() - retentionMs;
    for (const [key, entry] of entries)
      if (entry.completedAt !== undefined && entry.completedAt <= cutoff) entries.delete(key);
    for (const [callId, at] of cancellations) if (at <= cutoff) cancellations.delete(callId);
  };

  const request = (tag: string, payload: unknown): Promise<BridgeReply> => {
    if (closed) return Promise.resolve(cancelled());
    if (!MODEL_OPERATIONS.has(tag)) return run(tag, payload, new AbortController().signal);
    const callId =
      payload &&
      typeof payload === "object" &&
      "callId" in payload &&
      typeof payload.callId === "string"
        ? payload.callId
        : undefined;
    if (callId === undefined) return run(tag, payload, new AbortController().signal);
    prune();
    if (cancellations.has(callId)) return Promise.resolve(cancelled());
    const key = JSON.stringify([callId, tag]);
    const previous = entries.get(key);
    if (previous) return previous.promise;

    const controller = new AbortController();
    const entry: Entry = { callId, controller, promise: Promise.resolve(cancelled()) };
    entries.set(key, entry);
    entry.promise = Promise.resolve()
      .then(() => (controller.signal.aborted ? cancelled() : run(tag, payload, controller.signal)))
      .catch(() =>
        controller.signal.aborted
          ? cancelled()
          : refusalReply("failed", "The desktop operation failed."),
      )
      .then((reply) => {
        entry.completedAt = now();
        if (!SIDE_EFFECTS.has(tag)) entries.delete(key);
        return reply;
      });
    return entry.promise;
  };

  /** Interrupts the call if it is running; true when there was one to interrupt. */
  const cancelCall = (callId: string) => {
    prune();
    cancellations.set(callId, now());
    let interrupted = false;
    for (const entry of entries.values()) {
      if (entry.callId === callId && entry.completedAt === undefined) {
        entry.controller.abort();
        interrupted = true;
      }
    }
    return interrupted;
  };

  return {
    id,
    request,
    cancelCall,
    get active() {
      return [...entries.values()].filter((entry) => entry.completedAt === undefined).length;
    },
    async dispose() {
      closed = true;
      const active = [...entries.values()].filter((entry) => entry.completedAt === undefined);
      for (const entry of active) entry.controller.abort();
      await Promise.all(active.map((entry) => entry.promise));
      entries.clear();
      cancellations.clear();
    },
  };
};
