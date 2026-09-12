import { describe, expect, it, vi } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { makeSandbox, type SandboxRun } from "./sandbox.ts";
import type { runOwnedProcess } from "./process.ts";

const input: SandboxRun = {
  callId: "first",
  command: "first",
  cwd: "/tmp",
  allowWrite: ["/tmp"],
  timeoutMs: 1_000,
  network: "all",
};
const result = { code: 0, stdout: "", stderr: "", timedOut: false };
const managerFor = () => ({
  ...SandboxManager,
  initialize: vi.fn(async () => {}),
  isSupportedPlatform: () => true,
  checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
  updateConfig: vi.fn(),
  wrapWithSandboxArgv: vi.fn(async (command: string) => ({ argv: ["fake", command], env: {} })),
  annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
  cleanupAfterCommand: vi.fn(),
  reset: vi.fn(async () => {}),
});

const scopedSandbox = async (
  manager: ReturnType<typeof managerFor>,
  execute: typeof runOwnedProcess,
) => {
  const scope = await Effect.runPromise(Scope.make());
  const sandbox = await Effect.runPromise(makeSandbox(manager, execute).pipe(Scope.provide(scope)));
  return { sandbox, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

describe("sandbox lifetime", () => {
  it("serializes policy changes across services until child cleanup completes", async () => {
    const manager = managerFor();
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const clean = Promise.withResolvers<void>();
    const execute: typeof runOwnedProcess = ({ args }) =>
      Effect.gen(function* () {
        if (args[0] === "first") {
          running.resolve();
          yield* Effect.promise(() => finish.promise);
        }
        return result;
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            if (args[0] === "first") {
              cleaning.resolve();
              await clean.promise;
            }
          }),
        ),
      );
    const firstService = await scopedSandbox(manager, execute);
    const secondService = await scopedSandbox(manager, execute);
    try {
      const first = Effect.runPromise(firstService.sandbox.run(input));
      await running.promise;
      const second = Effect.runPromise(
        secondService.sandbox.run({
          ...input,
          command: "second",
          callId: "second",
          network: "none",
        }),
      );
      finish.resolve();
      await cleaning.promise;
      expect(manager.updateConfig).toHaveBeenCalledTimes(1);
      expect(manager.cleanupAfterCommand).not.toHaveBeenCalled();
      clean.resolve();
      await Promise.all([first, second]);
      expect(manager.updateConfig).toHaveBeenCalledTimes(2);
      expect(manager.cleanupAfterCommand).toHaveBeenCalledTimes(2);
      expect(manager.initialize).toHaveBeenCalledTimes(1);
      await firstService.close();
      expect(manager.reset).not.toHaveBeenCalled();
    } finally {
      clean.resolve();
      finish.resolve();
      await firstService.close();
      await secondService.close();
    }
    expect(manager.reset).toHaveBeenCalledOnce();
  });

  it("cancels queued work without preparing it and interrupts a running command before cleanup", async () => {
    const manager = managerFor();
    const running = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const clean = Promise.withResolvers<void>();
    const execute: typeof runOwnedProcess = () =>
      Effect.sync(() => running.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.promise(async () => {
            cleaning.resolve();
            await clean.promise;
          }),
        ),
      );
    const service = await scopedSandbox(manager, execute);
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const first = Effect.runPromiseExit(service.sandbox.run(input), {
      signal: firstController.signal,
    });
    await running.promise;
    const queued = Effect.runPromiseExit(
      service.sandbox.run({ ...input, command: "queued", callId: "queued" }),
      { signal: queuedController.signal },
    );
    queuedController.abort();
    expect(Exit.isFailure(await queued)).toBe(true);
    firstController.abort();
    await cleaning.promise;
    expect(manager.cleanupAfterCommand).not.toHaveBeenCalled();
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
    clean.resolve();
    expect(Exit.isFailure(await first)).toBe(true);
    expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce();
    await service.close();
  });

  it("waits for cancelled preparation to settle before releasing policy ownership", async () => {
    const manager = managerFor();
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<{ argv: string[]; env: NodeJS.ProcessEnv }>();
    manager.wrapWithSandboxArgv.mockImplementationOnce(() => {
      preparing.resolve();
      return prepared.promise;
    });
    const execute = vi.fn<typeof runOwnedProcess>(() => Effect.succeed(result));
    const service = await scopedSandbox(manager, execute);
    const controller = new AbortController();
    const first = Effect.runPromiseExit(service.sandbox.run(input), { signal: controller.signal });
    await preparing.promise;
    controller.abort();
    const second = Effect.runPromise(
      service.sandbox.run({ ...input, command: "second", callId: "second" }),
    );
    expect(manager.updateConfig).toHaveBeenCalledTimes(1);
    prepared.resolve({ argv: ["fake", "first"], env: {} });
    expect(Exit.isFailure(await first)).toBe(true);
    await second;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].args).toEqual(["second"]);
    expect(manager.cleanupAfterCommand).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it("only records successful initialization, allowing a failed start to retry", async () => {
    const manager = managerFor();
    manager.initialize.mockRejectedValueOnce(new Error("first start failed"));
    const service = await scopedSandbox(manager, () => Effect.succeed(result));
    expect(Exit.isFailure(await Effect.runPromiseExit(service.sandbox.run(input)))).toBe(true);
    expect(await Effect.runPromise(service.sandbox.run(input))).toMatchObject({ exitCode: 0 });
    expect(manager.initialize).toHaveBeenCalledTimes(2);
    await service.close();
  });
});
