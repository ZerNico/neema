import { createHash, randomUUID } from "node:crypto";
import { refusalReply, type BridgeReply } from "@chat/desktop-rpc";

const MODEL_OPERATIONS = new Set([
  "listDirectory",
  "readFile",
  "readBinary",
  "writeFile",
  "editFile",
  "movePath",
  "deletePath",
  "findFiles",
  "searchFiles",
  "runCommand",
]);

interface Entry {
  readonly callId: string | undefined;
  readonly fingerprint: string;
  readonly controller: AbortController;
  promise: Promise<BridgeReply>;
  completedAt?: number;
  bytes: number;
}

const fingerprint = (payload: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(payload, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest("hex");

const cancelled = () => refusalReply("failed", "This desktop call was cancelled.");

/** Replay survives renderer replacement, not an app restart. Retention is one day. */
export const makeExecutions = (
  run: (tag: string, payload: unknown, signal: AbortSignal) => Promise<BridgeReply>,
  options: {
    now?: () => number;
    retentionMs?: number;
    maxEntries?: number;
    maxBytes?: number;
  } = {},
) => {
  const id = randomUUID();
  const entries = new Map<string, Entry>();
  const tombstones = new Map<string, number>();
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  let bytes = 0;
  let closed = false;

  const prune = () => {
    const cutoff = now() - retentionMs;
    const activeCalls = new Set<string>();
    for (const [key, entry] of entries) {
      if (entry.completedAt === undefined && entry.callId !== undefined)
        activeCalls.add(entry.callId);
      if (entry.completedAt !== undefined && entry.completedAt <= cutoff) {
        bytes -= entry.bytes;
        entries.delete(key);
      }
    }
    for (const [callId, at] of tombstones) {
      if (at <= cutoff && !activeCalls.has(callId)) {
        tombstones.delete(callId);
      }
    }
  };

  const request = (tag: string, payload: unknown): Promise<BridgeReply> => {
    if (closed) return Promise.resolve(cancelled());
    if (!MODEL_OPERATIONS.has(tag)) return run(tag, payload, new AbortController().signal);
    prune();
    const callId =
      payload &&
      typeof payload === "object" &&
      "callId" in payload &&
      typeof payload.callId === "string"
        ? payload.callId
        : undefined;
    if (callId !== undefined && tombstones.has(callId)) return Promise.resolve(cancelled());
    let hash: string;
    try {
      hash = fingerprint(payload);
    } catch {
      return Promise.resolve(refusalReply("failed", "Malformed request."));
    }
    const key = callId === undefined ? randomUUID() : JSON.stringify([callId, tag]);
    const previous = entries.get(key);
    if (previous) {
      return previous.fingerprint === hash
        ? previous.promise
        : Promise.resolve(
            refusalReply("failed", "This call id was already used with a different payload."),
          );
    }
    // Refuse admission rather than discard active work or permit a replay to write twice.
    if (entries.size + tombstones.size >= maxEntries)
      return Promise.resolve(
        refusalReply("failed", "Desktop call retention is full. Try again later."),
      );
    const controller = new AbortController();
    const entry: Entry = {
      callId,
      fingerprint: hash,
      controller,
      bytes: 0,
      promise: Promise.resolve(cancelled()),
    };
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
        if (callId === undefined) {
          entries.delete(key);
        } else {
          entry.bytes = Buffer.byteLength(JSON.stringify(reply));
          bytes += entry.bytes;
          if (bytes > maxBytes) {
            // Keep the identity even when the bulky result cannot be retained.
            bytes -= entry.bytes;
            entry.bytes = 0;
            entry.promise = Promise.resolve(
              refusalReply(
                "failed",
                "This call completed, but its result is no longer retained. It will not be executed again.",
              ),
            );
          }
        }
        return reply;
      });
    return entry.promise;
  };

  const cancelCall = (callId: string) => {
    prune();
    if (!tombstones.has(callId) && entries.size + tombstones.size >= maxEntries) {
      // Existing calls can always be stopped, even at capacity.
      if (![...entries.values()].some((entry) => entry.callId === callId))
        throw new Error("Desktop cancellation retention is full.");
    }
    tombstones.set(callId, now());
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
      tombstones.clear();
      bytes = 0;
    },
  };
};
