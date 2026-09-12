import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Effect } from "effect";
import { DesktopError, LIMITS } from "@chat/desktop-rpc";

/** POSIX descendants must stay in the owned process group; Windows uses taskkill /T. */
export const terminateProcessTree = (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    return new Promise((resolve, reject) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
      return Promise.reject(cause);
  }
  return Promise.resolve();
};

const ownedProcesses = new Set<() => Promise<void>>();
export const disposeOwnedProcesses = () =>
  Promise.all([...ownedProcesses].map((stop) => stop())).then(() => {});

export interface CommandProcessInput {
  readonly program: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly outputChars?: number;
}

export interface ProcessDependencies {
  spawn(program: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  terminate(pid: number): Promise<void>;
}

/** Finalization waits for close and tree termination, including on fiber interruption. */
export const runOwnedProcess = (
  input: CommandProcessInput,
  dependencies: ProcessDependencies = { spawn, terminate: terminateProcessTree },
) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const child = dependencies.spawn(input.program, input.args, {
          cwd: input.cwd,
          env: input.env,
          shell: false,
          detached: process.platform !== "win32",
        });
        const outputChars = input.outputChars ?? LIMITS.outputChars;
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let exited = false;
        let stopping: Promise<void> | undefined;
        const stop = () => {
          // taskkill cannot enumerate a tree after its root exits. POSIX groups can.
          stopping ??=
            child.pid === undefined || (exited && process.platform === "win32")
              ? Promise.resolve()
              : dependencies.terminate(child.pid).catch((cause: unknown) => {
                  child.kill("SIGKILL");
                  stopping = undefined;
                  throw cause;
                });
          return stopping;
        };
        const completed = new Promise<{
          code: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
        }>((resolve) => {
          child.stdout?.on("data", (chunk: Buffer) => {
            if (stdout.length <= outputChars)
              stdout += chunk.toString("utf8").slice(0, outputChars + 1 - stdout.length);
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            if (stderr.length <= outputChars)
              stderr += chunk.toString("utf8").slice(0, outputChars + 1 - stderr.length);
          });
          child.on("error", (error) => {
            stderr += error.message;
          });
          child.on("exit", () => {
            exited = true;
            // Descendants can retain stdout after their parent exits, delaying close.
            void stop().catch(() => {});
          });
          child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr, timedOut }));
        });
        const timer = setTimeout(
          () => {
            timedOut = true;
            void stop().catch(() => child.kill("SIGKILL"));
          },
          Math.max(1, Math.min(input.timeoutMs, 2_147_483_647)),
        );
        const cleanup = async () => {
          clearTimeout(timer);
          // Even a successful shell can have left a background child behind.
          try {
            await stop();
          } finally {
            await completed;
          }
          ownedProcesses.delete(cleanup);
        };
        ownedProcesses.add(cleanup);
        return { completed, cleanup };
      },
      catch: (cause) => new DesktopError({ reason: "failed", message: String(cause) }),
    }),
    ({ completed }) => Effect.promise(() => completed),
    ({ cleanup }) => Effect.promise(cleanup),
  );
