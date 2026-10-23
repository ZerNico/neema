// Loaded by worker processes under plain Node in development, which knows no
// `~/` alias: this module and what worker code imports must use relative paths.
import type { Serializable } from "node:child_process";
import { parentPort } from "node:worker_threads";

/**
 * A failure a job can report by name: `code` is stable for callers, `message`
 * is for readers. Anything else a job throws is reported as a generic
 * failure, so internal errors never cross the boundary with their details.
 */
export class JobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JobError";
    this.code = code;
  }
}

/** A job's handler: its request fields in (with `kind`), its result out. */
export type JobHandler = (request: never) => unknown;
export type JobHandlers = Record<string, JobHandler>;

/** What a worker posts back for one request. */
export type JobReply = { readonly id: number } & (
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string }
);

/** Buffers a result owns whole, so a thread can move them instead of copying. */
function movable(value: unknown, found: ArrayBuffer[] = [], depth = 0): ArrayBuffer[] {
  if (value instanceof Uint8Array) {
    if (
      value.buffer instanceof ArrayBuffer &&
      value.byteOffset === 0 &&
      value.byteLength === value.buffer.byteLength &&
      !found.includes(value.buffer)
    )
      found.push(value.buffer);
  } else if (value && typeof value === "object" && depth < 3)
    for (const item of Object.values(value)) movable(item, found, depth + 1);
  return found;
}

/**
 * Serves a worker's jobs, one at a time, as a process (production: a timeout
 * kills it even inside native code) or a worker thread (tests).
 */
export function serveJobs(handlers: JobHandlers, options: { readonly label: string }) {
  const send = process.send?.bind(process);
  if (!parentPort && !send)
    throw new Error(`${options.label} requires a worker thread or process.`);
  // A worker whose server went away has no one left to answer.
  process.on("disconnect", () => process.exit(0));
  const handle = async (request: { readonly id: number; readonly kind: string }) => {
    let reply: JobReply;
    try {
      const handler = Object.hasOwn(handlers, request.kind) ? handlers[request.kind] : undefined;
      if (!handler) throw new JobError("unknown_job", `No ${request.kind} job here.`);
      reply = { id: request.id, ok: true, result: await handler(request as never) };
    } catch (error) {
      reply = {
        id: request.id,
        ok: false,
        code: error instanceof JobError ? error.code : "processing_error",
        message: error instanceof JobError ? error.message : `${options.label} failed.`,
      };
    }
    if (parentPort)
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker ports do not accept target origins.
      parentPort.postMessage(reply, reply.ok ? movable(reply.result) : []);
    else send!(reply as Serializable);
  };
  if (parentPort) parentPort.on("message", (message) => void handle(message));
  else process.on("message", (message) => void handle(message as Parameters<typeof handle>[0]));
}
