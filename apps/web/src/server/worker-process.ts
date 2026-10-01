import { fork, type Serializable } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { PoolWorker } from "./worker-pool.ts";

/** What a child process may see of the server's environment: nothing secret. */
const INHERITED = ["PATH", "NODE_ENV", "TMPDIR", "TEMP", "TMP", "LANG", "TZ"];

/**
 * A pool worker in its own process. A worker thread cannot be stopped while
 * native code runs, so a hung render kept its CPU after its timeout; a process
 * is killed outright. It gets no secrets and its own heap bound, since it
 * parses untrusted files.
 */
export function forkWorker(entry: URL, options: { readonly heapMb: number }): PoolWorker {
  const events = new EventEmitter();
  const child = fork(fileURLToPath(entry), [], {
    execArgv: [`--max-old-space-size=${options.heapMb}`],
    env: Object.fromEntries(
      INHERITED.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    ),
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("message", (message) => events.emit("message", message));
  child.on("error", (error) => events.emit("error", error));
  child.on("exit", (code, signal) => events.emit("exit", code ?? (signal ? 1 : 0)));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    on: (event, listener) => {
      events.on(event, listener);
      return undefined;
    },
    // Structured clone copies across processes; there is nothing to transfer.
    postMessage: (message) => {
      child.send(message as Serializable);
    },
    terminate: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}
