import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Schema } from "effect";
import { type DriverErrorCode, type Method, Methods, Response } from "./protocol.ts";

type Params<M extends Method> = (typeof Methods)[M]["params"]["Type"];
type Result<M extends Method> = (typeof Methods)[M]["result"]["Type"];

export class AppDriverError extends Error {
  readonly code: DriverErrorCode | "driver_exited";
  constructor(code: DriverErrorCode | "driver_exited", message: string) {
    super(message);
    this.code = code;
  }
}

/** A running app driver. Calls are answered in order; the driver serializes them. */
export interface AppDriver {
  /** False once the process has exited, crashed or was never started. */
  readonly alive: boolean;
  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  close(): void;
}

const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(Response));

/**
 * Starts the platform's driver. It must be spawned directly, never through `open` or a shell:
 * macOS charges a child's Accessibility and Screen Recording use to the app that spawned it,
 * and only that way does the driver run on neema's grants.
 */
export const startAppDriver = (executable: string): AppDriver => {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<
    number,
    { method: Method; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let next = 1;
  let exited: AppDriverError | null = null;

  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = decodeResponse(line);
    if (response.id === null) return;
    const waiting = pending.get(response.id);
    if (!waiting) return;
    pending.delete(response.id);
    if (response.error) {
      waiting.reject(new AppDriverError(response.error.code, response.error.message));
      return;
    }
    try {
      waiting.resolve(Schema.decodeUnknownSync(Methods[waiting.method].result)(response.result));
    } catch (error) {
      waiting.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  const fail = (message: string) => {
    exited ??= new AppDriverError("driver_exited", message);
    for (const waiting of pending.values()) waiting.reject(exited);
    pending.clear();
  };
  child.on("error", (error) => fail(`The app driver could not start: ${error.message}`));
  child.on("exit", (code, signal) => fail(`The app driver exited (${signal ?? code})`));

  return {
    call: (method, params) =>
      new Promise((resolve, reject) => {
        if (exited) return reject(exited);
        const id = next++;
        pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      }),
    get alive() {
      return exited === null;
    },
    close: () => {
      child.stdin.end();
    },
  };
};
