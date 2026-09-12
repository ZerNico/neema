import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runOwnedProcess, terminateProcessTree, type ProcessDependencies } from "./process.ts";

const input = { program: "fake", args: [], cwd: "/tmp", env: {}, timeoutMs: 10_000 };
const fixture = () => {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 4242 });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const started = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const launch = vi.fn<ProcessDependencies["spawn"]>(() => {
    started.resolve();
    return child;
  });
  const terminate = vi.fn((_pid: number) => {
    stopping.resolve();
    return stopped.promise;
  });
  return { child, launch, terminate, started, stopping, stopped };
};

describe("owned subprocesses", () => {
  it("cancels the owned tree and waits for close and tree cleanup", async () => {
    const test = fixture();
    const controller = new AbortController();
    const completed = Effect.runPromiseExit(
      runOwnedProcess(input, { spawn: test.launch, terminate: test.terminate }),
      { signal: controller.signal },
    );
    await test.started.promise;
    controller.abort();
    await test.stopping.promise;
    expect(test.terminate).toHaveBeenCalledWith(4242);
    expect(test.launch).toHaveBeenCalledWith(
      "fake",
      [],
      expect.objectContaining({ shell: false, detached: process.platform !== "win32" }),
    );
    let settled = false;
    void completed.then(() => {
      settled = true;
    });
    test.child.emit("close", null);
    expect(settled).toBe(false);
    test.stopped.resolve();
    expect(Exit.isFailure(await completed)).toBe(true);
  });

  it("times out through the same owned-tree cleanup path", async () => {
    vi.useFakeTimers();
    const test = fixture();
    try {
      const completed = Effect.runPromise(
        runOwnedProcess(
          { ...input, timeoutMs: 10 },
          { spawn: test.launch, terminate: test.terminate },
        ),
      );
      await test.started.promise;
      await vi.advanceTimersByTimeAsync(10);
      await test.stopping.promise;
      expect(test.terminate).toHaveBeenCalledWith(4242);
      test.child.emit("close", null);
      test.stopped.resolve();
      expect(await completed).toMatchObject({ timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform === "win32")(
    "stops descendants when their parent exits before stdout closes",
    async () => {
      const test = fixture();
      const completed = Effect.runPromise(
        runOwnedProcess(input, { spawn: test.launch, terminate: test.terminate }),
      );
      await test.started.promise;
      test.child.emit("exit", 0);
      await test.stopping.promise;
      expect(test.terminate).toHaveBeenCalledWith(4242);
      test.stopped.resolve();
      test.child.emit("close", 0);
      expect(await completed).toMatchObject({ code: 0, timedOut: false });
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills a real owned process group including its child",
    async () => {
      const ready = Promise.withResolvers<void>();
      const launch = vi.fn<ProcessDependencies["spawn"]>((program, args, options) => {
        const child = spawn(program, args, options);
        child.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("ready")) ready.resolve();
        });
        return child;
      });
      const command = `const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], {stdio:['ignore',1,2]}); setInterval(()=>{},1000);`;
      const controller = new AbortController();
      const completed = Effect.runPromiseExit(
        runOwnedProcess(
          {
            program: process.execPath,
            args: ["-e", command],
            cwd: "/tmp",
            env: process.env,
            timeoutMs: 10_000,
          },
          { spawn: launch, terminate: terminateProcessTree },
        ),
        { signal: controller.signal },
      );
      await ready.promise;
      controller.abort();
      // close cannot arrive while the grandchild still owns the inherited stdout pipe.
      expect(Exit.isFailure(await completed)).toBe(true);
    },
  );
});
