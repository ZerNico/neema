import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Exit, Scope } from "effect";
import { SandboxManager, SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSandbox, type SandboxRun, windowsReadDenies } from "./sandbox.ts";
import { makeWindowsSandbox, profileAncestors } from "./sandbox-windows.ts";
import { loadNetworkGrants } from "./network-grants.ts";
import type { runOwnedProcess } from "./process.ts";

const input: SandboxRun = {
  callId: "first",
  command: "first",
  cwd: "C:\\first",
  allowWrite: ["C:\\first"],
  timeoutMs: 1_000,
};
const secondInput = {
  ...input,
  callId: "second",
  command: "second",
  cwd: "C:\\second",
  allowWrite: ["C:\\second"],
};
const result = { code: 0, stdout: "done", stderr: "", timedOut: false };
const fixture = () => {
  const windows = makeWindowsSandbox();
  const release = vi.fn(async () => {});
  vi.spyOn(windows, "claimHost").mockImplementation(async () => {
    if (windows.failure) throw windows.failure;
    return release;
  });
  vi.spyOn(windows, "check").mockResolvedValue({ errors: [], warnings: [] });
  vi.spyOn(windows, "allowTraversal").mockResolvedValue();
  vi.spyOn(windows, "install").mockImplementation(async () => {
    throw new Error("Not a native install");
  });
  const manager = {
    ...SandboxManager,
    initialize: vi.fn<typeof SandboxManager.initialize>(async () => {}),
    isSupportedPlatform: () => true,
    checkDependenciesAsync: vi.fn(async () => {
      throw new Error("Cold Windows checks need an explicit broker");
    }),
    updateConfig: vi.fn<typeof SandboxManager.updateConfig>(),
    wrapWithSandboxArgv: vi.fn<typeof SandboxManager.wrapWithSandboxArgv>(
      async (command, _shell, config) => {
        if (config?.filesystem?.allowRead?.length || config?.filesystem?.allowWrite?.length)
          throw new Error("Per-exec grants are unsupported on Windows");
        return { argv: ["fake", "--", command], env: {} };
      },
    ),
    getSandboxViolationStore: () => new SandboxViolationStore(),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(async () => {}),
  };
  const open = async (
    execute: typeof runOwnedProcess = () => Effect.succeed(result),
    grants: Awaited<ReturnType<typeof loadNetworkGrants>> | null = null,
  ) => {
    const scope = await Effect.runPromise(Scope.make());
    const sandbox = await Effect.runPromise(
      makeSandbox(manager, execute, grants, { os: "win32", windows }).pipe(Scope.provide(scope)),
    );
    return { sandbox, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
  };
  return { windows, manager, release, open };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Windows command sessions", () => {
  it("uses explicit cold checks and puts each command's grants on its own exclusive session", async () => {
    const { manager, windows, release, open } = fixture();
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const clean = Promise.withResolvers<void>();
    const first = await open(() =>
      Effect.gen(function* () {
        running.resolve();
        yield* Effect.promise(() => finish.promise);
        return result;
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            cleaning.resolve();
            await clean.promise;
          }),
        ),
      ),
    );
    const second = await open();
    try {
      expect(await Effect.runPromise(first.sandbox.availability())).toEqual({ kind: "ready" });
      expect(windows.check).toHaveBeenCalled();
      expect(manager.checkDependenciesAsync).not.toHaveBeenCalled();
      const a = Effect.runPromise(first.sandbox.run(input));
      await running.promise;
      const b = Effect.runPromise(second.sandbox.run(secondInput));
      finish.resolve();
      await cleaning.promise;
      expect(manager.initialize).toHaveBeenCalledTimes(1);
      expect(manager.reset).not.toHaveBeenCalled();
      clean.resolve();
      await Promise.all([a, b]);
      expect(
        manager.initialize.mock.calls.map(([config]) => config?.filesystem.allowWrite),
      ).toEqual([input.allowWrite, secondInput.allowWrite]);
      expect(manager.initialize.mock.calls[0]?.[0]?.windows).toEqual(windows.config);
      expect(vi.mocked(windows.allowTraversal).mock.calls).toEqual([
        [input.allowWrite],
        [secondInput.allowWrite],
      ]);
      expect(vi.mocked(windows.allowTraversal).mock.invocationCallOrder[0]).toBeLessThan(
        manager.initialize.mock.invocationCallOrder[0]!,
      );
      // The profile ACL keeps the sandbox account out; only existing credential paths are stamped.
      const denyRead = manager.initialize.mock.calls[0]?.[0]?.filesystem.denyRead ?? [];
      expect(denyRead).not.toContain(homedir());
      expect(denyRead.filter((path) => !existsSync(path))).toEqual([]);
      for (const call of manager.wrapWithSandboxArgv.mock.calls)
        expect(call[2]).not.toHaveProperty("filesystem");
      expect(manager.reset).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(2);
      expect(manager.cleanupAfterCommand).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      clean.resolve();
      await first.close();
      await second.close();
    }
  });

  it("refuses a command whose folder cannot be opened to the sandbox", async () => {
    const { manager, windows, open } = fixture();
    vi.mocked(windows.allowTraversal).mockRejectedValueOnce(new Error("icacls failed"));
    const execute = vi.fn(() => Effect.succeed(result));
    const service = await open(execute);
    try {
      const error = await Effect.runPromise(Effect.flip(service.sandbox.run(input)));
      expect(error.reason).toBe("sandbox-unavailable");
      expect(error.message).toContain("icacls failed");
      expect(manager.initialize).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(await Effect.runPromise(service.sandbox.run(secondInput))).toMatchObject({
        exitCode: 0,
      });
    } finally {
      await service.close();
    }
  });

  it("uses the Windows gate across different manager objects and charges queue time", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { windows, manager, open } = fixture();
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const first = await open(() =>
      Effect.gen(function* () {
        running.resolve();
        yield* Effect.promise(() => finish.promise);
        return result;
      }),
    );
    const scope = await Effect.runPromise(Scope.make());
    const otherManager = {
      ...manager,
      initialize: vi.fn<typeof SandboxManager.initialize>(async () => {}),
    };
    const execute = vi.fn<typeof runOwnedProcess>(() => Effect.succeed(result));
    const second = await Effect.runPromise(
      makeSandbox(otherManager, execute, null, { os: "win32", windows }).pipe(Scope.provide(scope)),
    );
    try {
      const a = Effect.runPromise(first.sandbox.run(input));
      await running.promise;
      const b = Effect.runPromise(second.run(secondInput));
      now = 400;
      expect(otherManager.initialize).not.toHaveBeenCalled();
      finish.resolve();
      await Promise.all([a, b]);
      expect(execute.mock.calls[0]?.[0].timeoutMs).toBe(600);
    } finally {
      finish.resolve();
      await first.close();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("awaits cancelled initialization and checked rollback before closing", async () => {
    const { manager, open } = fixture();
    const initializing = Promise.withResolvers<void>();
    const initialized = Promise.withResolvers<void>();
    manager.initialize.mockImplementationOnce(() => {
      initializing.resolve();
      return initialized.promise;
    });
    const execute = vi.fn<typeof runOwnedProcess>(() => Effect.succeed(result));
    const service = await open(execute);
    const controller = new AbortController();
    const pending = Effect.runPromiseExit(service.sandbox.run(input), {
      signal: controller.signal,
    });
    await initializing.promise;
    controller.abort();
    const closing = service.close();
    expect(manager.reset).not.toHaveBeenCalled();
    initialized.resolve();
    expect(Exit.isFailure(await pending)).toBe(true);
    await closing;
    expect(manager.reset).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails already queued commands when the previous session's reset fails", async () => {
    const { manager, open } = fixture();
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const service = await open(() =>
      Effect.gen(function* () {
        running.resolve();
        yield* Effect.promise(() => finish.promise);
        return result;
      }),
    );
    manager.reset.mockRejectedValueOnce(new Error("ACL cleanup failed"));
    try {
      const a = Effect.runPromiseExit(service.sandbox.run(input));
      await running.promise;
      const b = Effect.runPromiseExit(service.sandbox.run(secondInput));
      finish.resolve();
      expect(Exit.isFailure(await a)).toBe(true);
      expect(Exit.isFailure(await b)).toBe(true);
      expect(manager.initialize).toHaveBeenCalledOnce();
      expect(manager.reset).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await service.close();
    }
  });

  it.each(["cancel", "expire"] as const)(
    "does not initialize a queued call after %s",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { manager, open } = fixture();
      const running = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const service = await open(() =>
        Effect.gen(function* () {
          running.resolve();
          yield* Effect.promise(() => finish.promise);
          return result;
        }),
      );
      try {
        const a = Effect.runPromise(service.sandbox.run({ ...input, timeoutMs: 10_000 }));
        await running.promise;
        const controller = new AbortController();
        const b = Effect.runPromiseExit(service.sandbox.run(secondInput), {
          signal: controller.signal,
        });
        if (mode === "cancel") controller.abort();
        else await vi.advanceTimersByTimeAsync(1_001);
        expect(Exit.isFailure(await b)).toBe(true);
        expect(manager.initialize).toHaveBeenCalledTimes(1);
        finish.resolve();
        await a;
        expect(manager.initialize).toHaveBeenCalledTimes(1);
      } finally {
        finish.resolve();
        await service.close();
      }
    },
  );

  it("charges readiness and wrapping to the remaining budget and refuses an expired spawn", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { manager, windows, open } = fixture();
    vi.mocked(windows.check).mockImplementation(async () => {
      now += 200;
      return { errors: [], warnings: [] };
    });
    const execute = vi.fn<typeof runOwnedProcess>(() => Effect.succeed(result));
    const service = await open(execute);
    try {
      await Effect.runPromise(service.sandbox.run(input));
      expect(execute.mock.calls[0]?.[0].timeoutMs).toBe(800);
      manager.wrapWithSandboxArgv.mockImplementationOnce(async () => {
        now += 900;
        return { argv: ["fake", "--", "command"], env: {} };
      });
      expect(Exit.isFailure(await Effect.runPromiseExit(service.sandbox.run(input)))).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(manager.reset).toHaveBeenCalledTimes(2);
    } finally {
      await service.close();
    }
  });

  it("settles interrupted preparation before reset and never spawns it", async () => {
    const { manager, open } = fixture();
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<{ argv: string[]; env: NodeJS.ProcessEnv }>();
    manager.wrapWithSandboxArgv.mockImplementationOnce(() => {
      preparing.resolve();
      return prepared.promise;
    });
    const execute = vi.fn<typeof runOwnedProcess>(() => Effect.succeed(result));
    const service = await open(execute);
    const controller = new AbortController();
    const command = Effect.runPromiseExit(service.sandbox.run(input), {
      signal: controller.signal,
    });
    await preparing.promise;
    controller.abort();
    const closing = service.close();
    expect(manager.reset).not.toHaveBeenCalled();
    prepared.resolve({ argv: ["fake", "--", "first"], env: {} });
    expect(Exit.isFailure(await command)).toBe(true);
    await closing;
    expect(execute).not.toHaveBeenCalled();
    expect(manager.reset).toHaveBeenCalledOnce();
    expect(Exit.isFailure(await Effect.runPromiseExit(service.sandbox.run(input)))).toBe(true);
  });

  it.each(["initialize", "wrapWithSandboxArgv"] as const)(
    "checks rollback after failed %s before allowing another command",
    async (operation) => {
      const { manager, open } = fixture();
      manager[operation].mockRejectedValueOnce(new Error("synthetic preparation failure"));
      const execute = vi.fn<typeof runOwnedProcess>(() => Effect.succeed(result));
      const service = await open(execute);
      try {
        expect(Exit.isFailure(await Effect.runPromiseExit(service.sandbox.run(input)))).toBe(true);
        expect(manager.reset).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
        await Effect.runPromise(service.sandbox.run(secondInput));
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        await service.close();
      }
    },
  );

  it.each(["stop", "timeout"] as const)(
    "keeps the next session out until %s has finished process cleanup",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { manager, open } = fixture();
      const running = Promise.withResolvers<void>();
      const cleaning = Promise.withResolvers<void>();
      const clean = Promise.withResolvers<void>();
      const service = await open(({ cwd }) =>
        cwd === input.cwd
          ? Effect.sync(() => running.resolve()).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.promise(async () => {
                  cleaning.resolve();
                  await clean.promise;
                }),
              ),
            )
          : Effect.succeed(result),
      );
      try {
        const controller = new AbortController();
        const a = Effect.runPromiseExit(service.sandbox.run(input), { signal: controller.signal });
        await running.promise;
        const b = Effect.runPromise(service.sandbox.run({ ...secondInput, timeoutMs: 10_000 }));
        if (mode === "stop") controller.abort();
        else await vi.advanceTimersByTimeAsync(1_001);
        await cleaning.promise;
        expect(manager.reset).not.toHaveBeenCalled();
        expect(manager.initialize).toHaveBeenCalledTimes(1);
        clean.resolve();
        expect(Exit.isFailure(await a)).toBe(true);
        await b;
        expect(manager.reset).toHaveBeenCalledTimes(2);
      } finally {
        clean.resolve();
        await service.close();
      }
    },
  );

  it.each(["reset", "process"] as const)(
    "blocks later services and setup after unconfirmed %s cleanup",
    async (failure) => {
      const { manager, windows, open } = fixture();
      if (failure === "reset") manager.reset.mockRejectedValueOnce(new Error("ACL still held"));
      const service = await open(() =>
        Effect.succeed(result).pipe(
          Effect.ensuring(failure === "process" ? Effect.die("tree cleanup failed") : Effect.void),
        ),
      );
      expect(Exit.isFailure(await Effect.runPromiseExit(service.sandbox.run(input)))).toBe(true);
      expect(windows.failure).not.toBeNull();
      await service.close();
      const next = await open();
      try {
        expect((await Effect.runPromise(next.sandbox.availability())).kind).toBe("unsupported");
        expect((await Effect.runPromise(next.sandbox.setUp())).kind).toBe("unsupported");
        expect(Exit.isFailure(await Effect.runPromiseExit(next.sandbox.run(secondInput)))).toBe(
          true,
        );
        expect(windows.install).not.toHaveBeenCalled();
        expect(manager.initialize).toHaveBeenCalledOnce();
      } finally {
        await next.close();
      }
    },
  );

  it("updates network policy during execution without replacing the active filesystem grants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-windows-grants-"));
    const grants = await loadNetworkGrants(directory);
    const { manager, open } = fixture();
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const service = await open(
      () =>
        Effect.gen(function* () {
          running.resolve();
          yield* Effect.promise(() => finish.promise);
          return result;
        }),
      grants,
    );
    try {
      const command = Effect.runPromise(service.sandbox.run(input));
      await running.promise;
      const filesystem = manager.initialize.mock.calls[0]?.[0]?.filesystem;
      await Effect.runPromise(service.sandbox.approveNetwork({ host: "example.com" }));
      expect(manager.updateConfig.mock.lastCall?.[0].filesystem).toEqual(filesystem);
      expect(manager.updateConfig.mock.lastCall?.[0].windows).toEqual(
        manager.initialize.mock.calls[0]?.[0]?.windows,
      );
      expect(manager.updateConfig.mock.lastCall?.[0].network.allowedDomains).toContain(
        "example.com:443",
      );
      await Effect.runPromise(service.sandbox.revokeNetwork({ host: "example.com" }));
      expect(manager.updateConfig.mock.lastCall?.[0].filesystem).toEqual(filesystem);
      expect(manager.updateConfig.mock.lastCall?.[0].network.allowedDomains).not.toContain(
        "example.com:443",
      );
      finish.resolve();
      await command;
    } finally {
      finish.resolve();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("excludes another host until ownership is released", async () => {
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\neema-test-${randomUUID()}`
      : join(tmpdir(), `neema-${randomUUID()}.sock`);
  const first = makeWindowsSandbox(pipe);
  const second = makeWindowsSandbox(pipe);
  const release = await first.claimHost();
  try {
    await expect(second.claimHost()).rejects.toThrow();
  } finally {
    await release();
  }
  const releaseSecond = await second.claimHost();
  await releaseSecond();
});

describe("Windows read denies", () => {
  it("stamps only existing credentials inside an existing grant", () => {
    const home = join(tmpdir(), "profile");
    const at = (...segments: string[]) => join(home, ...segments);
    const present = new Set([
      at(".cache"),
      at(".cache", "gh"),
      at(".cargo", "credentials"),
      at(".m2"),
      at(".m2", "settings.xml"),
    ]);
    const exists = (path: string) => present.has(path);
    const denies = [
      at(".cache", "gh"),
      at(".cache", "huggingface", "token"),
      at(".cargo", "credentials"),
      at(".m2", "settings.xml"),
      at(".gradle", "init.d"),
    ];
    const roots = [at(".cache"), at(".gradle"), at(".m2"), join(tmpdir(), "project")];
    // Missing credentials, missing grants and ungranted trees stay off the profile.
    expect(windowsReadDenies(denies, roots, exists)).toEqual([
      at(".cache", "gh"),
      at(".m2", "settings.xml"),
    ]);
    expect(windowsReadDenies(denies, [home], exists)).toEqual([]);
    expect(windowsReadDenies(denies, [home], (path) => path !== at(".m2"))).toEqual(denies);
  });
});

describe("Windows profile traversal", () => {
  it("opens only profile folders above each attached root", () => {
    const home = join(tmpdir(), "profile");
    const at = (...segments: string[]) => join(home, ...segments);
    expect(
      profileAncestors([at("code", "app"), at("code", "lib"), at("notes"), home], home),
    ).toEqual([at("code"), home]);
    expect(
      profileAncestors([join(tmpdir(), "elsewhere", "app"), join(tmpdir(), "profile-old")], home),
    ).toEqual([]);
  });
});
