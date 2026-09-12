import type { ChildProcess } from "node:child_process";

export const DEV_RESTART = "chat-desktop:dev-restart";

/** Serializes rebuilds against the actual Electron process, not its CLI wrapper. */
export function makeDevReloader(host: {
  spawn(): ChildProcess;
  quit(): void;
  reportError(cause: unknown): void;
}) {
  let child: ChildProcess | undefined;
  let stopping = false;
  let replacing = false;
  let queue = Promise.resolve();

  const stopChild = async () => {
    const previous = child;
    if (!previous) return;
    if (previous.exitCode !== null || previous.signalCode !== null) {
      child = undefined;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout>;
      const closed = () => {
        clearTimeout(deadline);
        resolve();
      };
      previous.once("close", closed);
      deadline = setTimeout(() => {
        host.reportError(
          new Error("Electron did not finish cleanup; forcing the old process to stop."),
        );
        previous.kill("SIGKILL");
        deadline = setTimeout(() => {
          previous.removeListener("close", closed);
          reject(
            new Error("The previous Electron process has not exited; refusing to launch another."),
          );
        }, 5000);
      }, 10000);
      if (previous.connected) {
        previous.send(DEV_RESTART, (error) => {
          if (error && previous.exitCode === null && previous.signalCode === null) {
            previous.kill("SIGTERM");
          }
        });
      } else previous.kill("SIGTERM");
    });
    child = undefined;
  };

  return {
    restart() {
      queue = queue.then(async () => {
        if (stopping) return;
        replacing = true;
        try {
          await stopChild();
          if (stopping) return;
          const next = host.spawn();
          child = next;
          next.once("error", host.reportError);
          next.once("exit", (code) => {
            if (next === child && !replacing && !stopping && code === 0) host.quit();
          });
        } finally {
          replacing = false;
        }
      });
      return queue;
    },
    stop() {
      stopping = true;
      // A failed restart must still leave shutdown able to stop the old process.
      queue = queue.catch(host.reportError).then(stopChild);
      return queue;
    },
  };
}
