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
  it("runs commands from separate services concurrently under one started manager", async () => {
    const manager = managerFor();
    const running = { first: Promise.withResolvers<void>(), second: Promise.withResolvers<void>() };
    const finish = Promise.withResolvers<void>();
    const execute: typeof runOwnedProcess = ({ args }) =>
      Effect.gen(function* () {
        running[args[0] as "first" | "second"].resolve();
        yield* Effect.promise(() => finish.promise);
        return result;
      });
    const firstService = await scopedSandbox(manager, execute);
    const secondService = await scopedSandbox(manager, execute);
    try {
      const first = Effect.runPromise(firstService.sandbox.run(input));
      const second = Effect.runPromise(
        secondService.sandbox.run({ ...input, command: "second", callId: "second" }),
      );
      // Both children are alive at once: neither waited for the other.
      await Promise.all([running.first.promise, running.second.promise]);
      expect(manager.wrapWithSandboxArgv).toHaveBeenCalledTimes(2);
      expect(manager.initialize).toHaveBeenCalledTimes(1);
      // The policy is fixed at initialize; nothing rewrites it per command.
      expect(manager.updateConfig).not.toHaveBeenCalled();
      finish.resolve();
      await Promise.all([first, second]);
      // Mount cleanup is process-wide, so it runs once the last command is out.
      expect(manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
      await firstService.close();
      expect(manager.reset).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await firstService.close();
      await secondService.close();
    }
    expect(manager.reset).toHaveBeenCalledOnce();
  });

  it("does not reset the manager while a command is still running", async () => {
    const manager = managerFor();
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const execute: typeof runOwnedProcess = () =>
      Effect.gen(function* () {
        running.resolve();
        yield* Effect.promise(() => finish.promise);
        return result;
      });
    const service = await scopedSandbox(manager, execute);
    const command = Effect.runPromise(service.sandbox.run(input));
    await running.promise;
    const closing = service.close();
    // The close is waiting on the drain, not racing the child.
    await Promise.resolve();
    expect(manager.reset).not.toHaveBeenCalled();
    finish.resolve();
    await command;
    await closing;
    expect(manager.reset).toHaveBeenCalledOnce();
  });

  it("interrupts a running command and cleans up after it", async () => {
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
    const controller = new AbortController();
    const first = Effect.runPromiseExit(service.sandbox.run(input), { signal: controller.signal });
    await running.promise;
    controller.abort();
    await cleaning.promise;
    expect(manager.cleanupAfterCommand).not.toHaveBeenCalled();
    clean.resolve();
    expect(Exit.isFailure(await first)).toBe(true);
    expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce();
    await service.close();
  });

  it("counts a cancelled preparation out before the manager is released", async () => {
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
    const closing = service.close();
    await Promise.resolve();
    expect(manager.reset).not.toHaveBeenCalled();
    prepared.resolve({ argv: ["fake", "first"], env: {} });
    expect(Exit.isFailure(await first)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    await closing;
    expect(manager.reset).toHaveBeenCalledOnce();
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
