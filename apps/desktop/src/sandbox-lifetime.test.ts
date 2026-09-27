import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadNetworkGrants, networkGrantsDirectory } from "./network-grants.ts";
import { Effect, Exit, Scope } from "effect";
import { SandboxManager, SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { makeSandbox, type SandboxRun } from "./sandbox.ts";
import { commandWithEnvironment } from "./sandbox-environment.ts";
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
  wrapWithSandboxArgv: vi.fn(async (command: string) => ({
    argv: platform() === "win32" ? ["fake", "--", command] : ["fake", command],
    env: {},
  })),
  annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
  getSandboxViolationStore: () => new SandboxViolationStore(),
  cleanupAfterCommand: vi.fn(),
  reset: vi.fn(async () => {}),
});

const scopedSandbox = async (
  manager: ReturnType<typeof managerFor>,
  execute: typeof runOwnedProcess,
  grants?: Awaited<ReturnType<typeof loadNetworkGrants>>,
) => {
  const scope = await Effect.runPromise(Scope.make());
  const sandbox = await Effect.runPromise(
    makeSandbox(manager, execute, grants).pipe(Scope.provide(scope)),
  );
  return { sandbox, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

describe("sandbox lifetime", () => {
  it("runs commands from separate services concurrently under one started manager", async () => {
    const manager = managerFor();
    const running = { first: Promise.withResolvers<void>(), second: Promise.withResolvers<void>() };
    const finish = Promise.withResolvers<void>();
    const execute: typeof runOwnedProcess = ({ cwd }) =>
      Effect.gen(function* () {
        (cwd === input.cwd ? running.first : running.second).resolve();
        yield* Effect.promise(() => finish.promise);
        return result;
      });
    const firstService = await scopedSandbox(manager, execute);
    const secondService = await scopedSandbox(manager, execute);
    try {
      const first = Effect.runPromise(firstService.sandbox.run(input));
      const second = Effect.runPromise(
        secondService.sandbox.run({
          ...input,
          command: "second",
          callId: "second",
          cwd: "/tmp/second",
          allowWrite: ["/tmp/second"],
        }),
      );
      // Both children are alive at once: neither waited for the other.
      await Promise.all([running.first.promise, running.second.promise]);
      expect(manager.wrapWithSandboxArgv).toHaveBeenCalledTimes(2);
      for (const [command, cwd] of [
        ["first", "/tmp"],
        ["second", "/tmp/second"],
      ] as const) {
        expect(manager.wrapWithSandboxArgv).toHaveBeenCalledWith(
          commandWithEnvironment(command, cwd),
          undefined,
          expect.objectContaining({ filesystem: expect.objectContaining({ allowWrite: [cwd] }) }),
          undefined,
          cwd,
          { commandId: command, commandText: command },
        );
      }
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

  it("updates complete policy for approved destinations and protects the grant directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-grants-"));
    const directory = networkGrantsDirectory(root);
    const grants = await loadNetworkGrants(directory);
    const manager = managerFor();
    const service = await scopedSandbox(manager, () => Effect.succeed(result), grants);
    const grant = { host: "example.com" };
    try {
      await Effect.runPromise(service.sandbox.run(input));
      expect(manager.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          filesystem: expect.objectContaining({ denyWrite: [directory] }),
        }),
      );
      expect(manager.wrapWithSandboxArgv).toHaveBeenCalledWith(
        commandWithEnvironment("first", input.cwd),
        undefined,
        expect.objectContaining({
          filesystem: expect.objectContaining({ denyWrite: [directory] }),
        }),
        undefined,
        "/tmp",
        expect.anything(),
      );
      await Effect.runPromise(service.sandbox.approveNetwork(grant));
      expect(manager.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          filesystem: expect.objectContaining({
            denyRead: expect.any(Array),
            denyWrite: [directory],
          }),
          network: expect.objectContaining({
            allowedDomains: expect.arrayContaining(["example.com:443"]),
          }),
        }),
      );
      const domains = manager.updateConfig.mock.lastCall?.[0].network.allowedDomains;
      expect(domains).not.toContain("example.com");
      expect(domains).not.toContain("example.com:80");
      expect(domains).not.toContain("example.com:8443");
      await Effect.runPromise(service.sandbox.revokeNetwork(grant));
      expect(manager.updateConfig.mock.lastCall?.[0].network.allowedDomains).not.toContain(
        "example.com:443",
      );
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back a grant when the proxy rejects a policy update", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-grants-"));
    const directory = networkGrantsDirectory(root);
    const grants = await loadNetworkGrants(directory);
    const manager = managerFor();
    const service = await scopedSandbox(manager, () => Effect.succeed(result), grants);
    const grant = { host: "example.org" };
    try {
      await Effect.runPromise(service.sandbox.run(input));
      manager.updateConfig.mockImplementationOnce(() => {
        throw new Error("proxy failed");
      });
      expect(
        Exit.isFailure(await Effect.runPromiseExit(service.sandbox.approveNetwork(grant))),
      ).toBe(true);
      expect(grants.list()).toEqual([]);
      expect((await loadNetworkGrants(directory)).list()).toEqual([]);
      expect(manager.updateConfig.mock.lastCall?.[0].network.allowedDomains).not.toContain(
        "example.org:443",
      );
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for an approved write to settle before completing cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-grants-"));
    const directory = networkGrantsDirectory(root);
    const grants = await loadNetworkGrants(directory);
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const manager = managerFor();
    const service = await scopedSandbox(manager, () => Effect.succeed(result), {
      ...grants,
      add: async (grant) => {
        writing.resolve();
        await release.promise;
        await grants.add(grant);
      },
    });
    const controller = new AbortController();
    try {
      await Effect.runPromise(service.sandbox.run(input));
      const change = Effect.runPromiseExit(
        service.sandbox.approveNetwork({ host: "example.org" }),
        { signal: controller.signal },
      );
      await writing.promise;
      controller.abort();
      expect(manager.updateConfig).not.toHaveBeenCalled();
      release.resolve();
      expect(Exit.isFailure(await change)).toBe(true);
      expect((await loadNetworkGrants(directory)).list()).toEqual([{ host: "example.org" }]);
      expect(manager.updateConfig.mock.lastCall?.[0].network.allowedDomains).toContain(
        "example.org:443",
      );
    } finally {
      release.resolve();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
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
