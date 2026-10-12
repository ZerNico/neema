import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { Cause, Context, Duration, Effect, Exit, Layer, Semaphore } from "effect";
import { windowsSandbox } from "./sandbox-windows.ts";
import { runOwnedProcess } from "./process.ts";
import {
  childEnvironment,
  commandWithEnvironment,
  deniedEnvironmentNames,
  forSandboxedChild,
} from "./sandbox-environment.ts";
import { loadNetworkGrants, type NetworkGrants } from "./network-grants.ts";
import {
  DesktopError,
  LIMITS,
  type NetworkGrant,
  type SandboxAvailability,
} from "@chat/desktop-rpc";

const home = homedir();
const inHome = (...segments: string[]) => join(home, ...segments);

/**
 * Where toolchains keep what a build reads: version managers, package stores
 * and caches. Everything else under the home directory is denied, because a
 * command is driven by file contents the user did not write and the home
 * directory is where every CLI keeps its credentials. Outside the home
 * directory the disk stays readable; compilers and system libraries live there.
 *
 * A tool installed somewhere unusual fails with a denial that names the path,
 * which is the failure to prefer over a readable `~/.git-credentials`.
 */
const TOOLCHAIN_READ = [
  // Node
  inHome(".nvm"),
  inHome(".npm"),
  inHome(".pnpm"),
  inHome(".local", "share", "pnpm"),
  inHome("Library", "pnpm"),
  inHome(".yarn"),
  inHome(".bun"),
  inHome(".deno"),
  inHome(".volta"),
  inHome(".node-gyp"),
  // Python
  inHome(".pyenv"),
  inHome(".local", "share", "uv"),
  inHome(".local", "share", "virtualenvs"),
  inHome(".virtualenvs"),
  inHome(".conda"),
  inHome("miniconda3"),
  inHome("anaconda3"),
  inHome("Library", "Python"),
  inHome(".config", "uv"),
  // Rust, Go, Ruby, JVM
  inHome(".cargo", "bin"),
  inHome(".cargo", "registry"),
  inHome(".cargo", "git"),
  inHome(".rustup"),
  inHome("go"),
  inHome(".go"),
  inHome(".gem"),
  inHome(".rbenv"),
  inHome(".sdkman"),
  inHome(".m2", "repository"),
  inHome(".m2", "wrapper"),
  inHome(".gradle", "caches"),
  inHome(".gradle", "wrapper"),
  inHome(".gradle", "jdks"),
  inHome(".gradle", "native"),
  // Cross-language version managers and user-local installs
  inHome(".asdf"),
  inHome(".local", "share", "mise"),
  inHome(".config", "mise"),
  inHome(".local", "bin"),
  inHome(".local", "lib"),
  inHome(".nix-profile"),
  // Caches, and git's identity (name and email; the credential file stays denied)
  inHome(".cache"),
  inHome("Library", "Caches"),
  inHome(".gitconfig"),
  inHome(".config", "git"),
];

/** Named credential/config denies survive both toolchain and attached-parent allows in SRT. */
const TOOLCHAIN_READ_DENIES = [
  inHome(".cache", "huggingface", "token"),
  inHome(".cache", "gh"),
  inHome(".config", "git", "credentials"),
  // Keep these denied even when an attached parent re-allows their directory.
  inHome(".cargo", "credentials"),
  inHome(".cargo", "credentials.toml"),
  inHome(".cargo", "config"),
  inHome(".cargo", "config.toml"),
  inHome(".m2", "settings.xml"),
  inHome(".m2", "settings-security.xml"),
  inHome(".gradle", "gradle.properties"),
  inHome(".gradle", "init.gradle"),
  inHome(".gradle", "init.gradle.kts"),
  inHome(".gradle", "init.d"),
  inHome(".config", "pip"),
  inHome(".pip"),
  inHome("Library", "Application Support", "pip"),
];

/**
 * Everything a command may never touch, whatever folder is attached.
 *
 * Reads are deny-then-allow in srt, so the home directory is denied as a
 * whole and the toolchain paths above are re-allowed inside it. Writes are
 * allow-only and this config lists none, so the *only* writable place is the
 * set of folders passed per call.
 *
 * Network is one policy for this desktop profile. srt keeps a single proxy
 * per process; a human-approved exact destination is shared by all its chats.
 * The connected app asks for consent before requesting a grant.
 */
const GLOBAL_POLICY: SandboxRuntimeConfig = {
  filesystem: {
    denyRead: [home, ...TOOLCHAIN_READ_DENIES],
    allowRead: TOOLCHAIN_READ,
    allowWrite: [],
    denyWrite: [],
  },
  network: {
    allowedDomains: [
      "registry.npmjs.org",
      "*.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "files.pythonhosted.org",
      "crates.io",
      "*.crates.io",
      "proxy.golang.org",
      "github.com",
      "*.github.com",
      "objects.githubusercontent.com",
    ],
    deniedDomains: [],
    deniedResolvedAddresses: [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "100.64.0.0/10",
      "fc00::/7",
    ],
    strictAllowlist: true,
  },
};

const policyWithGrants = (grants: NetworkGrants | null): SandboxRuntimeConfig => ({
  ...GLOBAL_POLICY,
  filesystem: {
    ...GLOBAL_POLICY.filesystem,
    denyWrite: grants ? [grants.directory] : [],
  },
  network: {
    ...GLOBAL_POLICY.network,
    allowedDomains: [
      ...GLOBAL_POLICY.network.allowedDomains,
      // Bare hosts in SRT allow every port; website grants only allow 443.
      ...(grants?.list().map(({ host }) => `${host}:443`) ?? []),
    ],
  },
});

export interface SandboxRun {
  readonly callId: string;
  readonly command: string;
  /** Already resolved and proven inside a folder by `resolveInFolder`. */
  readonly cwd: string;
  /** Every attached folder's real root: the only places a command may write. */
  readonly allowWrite: ReadonlyArray<string>;
  readonly timeoutMs: number;
}

export interface SandboxResult {
  readonly exitCode: number;
  readonly output: string;
  readonly truncated: boolean;
  readonly violations: readonly string[];
}

export class Sandbox extends Context.Service<
  Sandbox,
  {
    availability(): Effect.Effect<SandboxAvailability>;
    /** Windows only; elsewhere it just re-reports availability. */
    setUp(): Effect.Effect<SandboxAvailability>;
    run(input: SandboxRun): Effect.Effect<SandboxResult, DesktopError>;
    grants(): Effect.Effect<readonly NetworkGrant[]>;
    approveNetwork(grant: NetworkGrant): Effect.Effect<void, DesktopError>;
    revokeNetwork(grant: NetworkGrant): Effect.Effect<void, DesktopError>;
  }
>()("desktop/Sandbox") {
  static readonly layer = Layer.effect(
    Sandbox,
    Effect.suspend(() => makeSandbox()),
  );

  static readonly layerAt = (directory: string) =>
    Layer.effect(
      Sandbox,
      Effect.flatMap(
        Effect.promise(() => loadNetworkGrants(directory)),
        (grants) => makeSandbox(SandboxManager, runOwnedProcess, grants),
      ),
    );
}

interface ManagerState {
  config: SandboxRuntimeConfig | null;
  owners: number;
  running: number;
  idle: ReturnType<typeof Promise.withResolvers<void>> | null;
}
const managerStates = new WeakMap<typeof SandboxManager, ManagerState>();
// Outer command/network permits may take this lock, never the other way around.
const lifecyclePermit = Semaphore.makeUnsafe(1);
const networkPermit = Semaphore.makeUnsafe(1);

const unavailable = (cause: unknown) =>
  new DesktopError({ reason: "sandbox-unavailable", message: String(cause) });
const expired = () =>
  new DesktopError({ reason: "timed-out", message: "The command’s time limit was reached." });
const remaining = (deadline: number) =>
  Effect.suspend(() => {
    const ms = deadline - performance.now();
    return ms > 0 ? Effect.succeed(ms) : Effect.fail(expired());
  });
const filesystemFor = (input: SandboxRun, grants: NetworkGrants | null) => ({
  denyRead: GLOBAL_POLICY.filesystem.denyRead,
  allowRead: [...TOOLCHAIN_READ, ...input.allowWrite],
  allowWrite: [...input.allowWrite],
  denyWrite: grants ? [grants.directory] : [],
});
const isWithin = (path: string, root: string) => {
  const rest = relative(root, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
};
/**
 * A Windows profile admits only its owner, SYSTEM and administrators, so a deny matters
 * only inside a grant. Each SRT deny restamps its parents, and a missing one becomes a
 * placeholder file in the user's home.
 */
export const windowsReadDenies = (
  denies: ReadonlyArray<string>,
  roots: ReadonlyArray<string>,
  exists: (path: string) => boolean = existsSync,
) =>
  denies.filter(
    (path) => exists(path) && roots.some((root) => isWithin(path, root) && exists(root)),
  );
const windowsFilesystemFor = (input: SandboxRun, grants: NetworkGrants | null) => {
  const filesystem = filesystemFor(input, grants);
  return {
    ...filesystem,
    denyRead: windowsReadDenies(TOOLCHAIN_READ_DENIES, filesystem.allowRead),
  };
};

export const makeSandbox = (
  manager = SandboxManager,
  execute = runOwnedProcess,
  grants: NetworkGrants | null = null,
  { os = platform(), windows = windowsSandbox } = {},
) =>
  Effect.gen(function* () {
    const state: ManagerState = managerStates.get(manager) ?? {
      config: null,
      owners: 0,
      running: 0,
      idle: null,
    };
    managerStates.set(manager, state);
    state.owners += 1;
    let closed = false;
    const onWindows = os === "win32";

    const reset = Effect.tryPromise({
      try: async () => {
        try {
          await manager.reset();
          state.config = null;
        } catch (cause) {
          if (onWindows) windows.block(cause);
          throw cause;
        }
      },
      catch: unavailable,
    });

    const withWindowsHost = <A, E>(effect: Effect.Effect<A, E>) =>
      windows.permit.withPermit(
        Effect.acquireUseRelease(
          Effect.tryPromise({ try: () => windows.claimHost(), catch: unavailable }),
          () => effect,
          (release) => Effect.promise(release),
        ),
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        yield* lifecyclePermit.withPermit(
          Effect.sync(() => {
            state.owners -= 1;
          }),
        );
        // The last command needs the lifecycle lock to finish. Wait outside it.
        while (true) {
          const idle = yield* lifecyclePermit.withPermit(
            Effect.gen(function* () {
              if (state.owners > 0) return null;
              if (state.running > 0) return state.idle!.promise;
              // Windows resets each command while holding its host ownership.
              if (!onWindows && state.config) yield* reset.pipe(Effect.orDie);
              return null;
            }),
          );
          if (!idle) break;
          yield* Effect.promise(() => idle);
        }
        if (onWindows) yield* windows.permit.withPermit(Effect.void);
      }),
    );

    const availability = (): Effect.Effect<SandboxAvailability> =>
      Effect.gen(function* () {
        if (onWindows && windows.failure) {
          return {
            kind: "unsupported",
            reason: "Sandbox cleanup failed. Commands are disabled for this app session.",
          } as const;
        }
        if (closed) return { kind: "unsupported", reason: "The sandbox is closing." } as const;
        if (!manager.isSupportedPlatform()) {
          return {
            kind: "unsupported",
            reason: "Running commands needs macOS, Linux or Windows. WSL 1 is not supported.",
          } as const;
        }
        const check = yield* Effect.promise(() =>
          Promise.resolve()
            .then(() => (onWindows ? windows.check() : manager.checkDependenciesAsync()))
            .catch(() => ({
              errors: ["Could not check the sandbox requirements."],
              warnings: [] as string[],
            })),
        );
        if (check.errors.length === 0) return { kind: "ready" } as const;
        // Windows ships its own installer for exactly this, and it is the one
        // case the app can fix without sending the user to a terminal.
        if (onWindows) {
          return { kind: "setup-needed", platform: "windows" } as const;
        }
        return {
          kind: "missing-deps",
          missing: check.errors,
          hint:
            os === "linux"
              ? "Install bubblewrap, socat and ripgrep, then check again."
              : "Install ripgrep, then check again.",
        } as const;
      });

    const setUp = (): Effect.Effect<SandboxAvailability> => {
      if (!onWindows) return availability();
      return withWindowsHost(
        lifecyclePermit
          .withPermit(
            Effect.promise(async () => {
              if (closed || windows.failure) return;
              try {
                await windows.install();
              } catch {
                // A cancelled elevation prompt leaves setup available to try again.
              }
            }).pipe(Effect.uninterruptible),
          )
          .pipe(Effect.andThen(availability)),
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed({ kind: "unsupported" as const, reason: error.message }),
        ),
      );
    };

    const runCounted = (
      input: SandboxRun,
      deadline: number,
    ): Effect.Effect<SandboxResult, DesktopError> =>
      Effect.gen(function* () {
        yield* remaining(deadline);
        const { argv, env } = yield* Effect.tryPromise({
          try: async () => {
            const wrapped = await manager.wrapWithSandboxArgv(
              commandWithEnvironment(input.command, input.cwd, os),
              undefined,
              // Windows grants belong to initialize(), never the per-exec API.
              {
                // SRT can compose inherited settings into argv (notably Java).
                // Deny them before composition, without changing the parent env.
                credentials: {
                  envVars: deniedEnvironmentNames(process.env).map((name) => ({
                    name,
                    mode: "deny" as const,
                  })),
                },
                ...(!onWindows ? { filesystem: filesystemFor(input, grants) } : {}),
              },
              undefined,
              input.cwd,
              // Violations key on the first 100 characters of the command by
              // default, so two long commands sharing a prefix would report
              // each other's denials. The call id is unique by construction.
              { commandId: input.callId, commandText: input.command },
            );
            return {
              argv: forSandboxedChild(wrapped.argv, input.cwd, os),
              env: childEnvironment(wrapped.env, os),
            };
          },
          catch: (cause) =>
            new DesktopError({
              reason: "sandbox-unavailable",
              message: `Could not prepare the command: ${String(cause)}`,
            }),
        }).pipe(Effect.uninterruptible);

        const [program, ...args] = argv;
        if (!program) {
          return yield* Effect.fail(
            new DesktopError({ reason: "failed", message: "The command was empty." }),
          );
        }

        const finished = yield* execute({
          program,
          args,
          cwd: input.cwd,
          env,
          timeoutMs: yield* remaining(deadline),
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              // Process finalization defects mean the next ACL session cannot be admitted.
              if (onWindows && Exit.hasDies(exit)) windows.block(Cause.pretty(exit.cause));
            }),
          ),
        );

        if (finished.timedOut) {
          return yield* Effect.fail(
            new DesktopError({
              reason: "timed-out",
              message: `The command was still running after ${Math.round(input.timeoutMs / 1000)}s and was stopped.`,
            }),
          );
        }

        // The appended annotation follows stderr, which can be arbitrarily
        // long. Take short individual events instead so network denials survive.
        const violations = manager
          .getSandboxViolationStore()
          .getViolationsForCommand(input.callId)
          .slice(0, 20)
          .map((event) => event.line.slice(0, 500));

        const combined = [finished.stdout, finished.stderr].filter(Boolean).join("\n");
        const truncated = combined.length > LIMITS.outputChars;
        return {
          exitCode: finished.code,
          output: truncated ? combined.slice(0, LIMITS.outputChars) : combined,
          truncated,
          violations,
        };
      });

    const commandSession = (input: SandboxRun, deadline: number) =>
      Effect.suspend(() => {
        let admitted = false;
        return lifecyclePermit
          .withPermit(
            Effect.gen(function* () {
              yield* remaining(deadline);
              if (closed || (onWindows && windows.failure)) {
                return yield* Effect.fail(
                  unavailable(windows.failure ?? "The sandbox is closing."),
                );
              }
              // Admission and start are atomic with respect to last-owner disposal.
              if (state.running === 0) state.idle = Promise.withResolvers<void>();
              state.running += 1;
              admitted = true;
              if (!state.config) {
                const policy = policyWithGrants(grants);
                if (onWindows) {
                  policy.filesystem = windowsFilesystemFor(input, grants);
                  policy.windows = windows.config;
                  yield* Effect.tryPromise({
                    try: () => windows.allowTraversal(input.allowWrite),
                    catch: (cause) =>
                      unavailable(`Could not open the folder to the sandbox: ${String(cause)}`),
                  });
                }
                yield* Effect.tryPromise({
                  try: () => manager.initialize(policy),
                  catch: (cause) => unavailable(`Could not start the sandbox: ${String(cause)}`),
                });
                state.config = policy;
              }
            }).pipe(Effect.uninterruptible),
          )
          .pipe(
            Effect.andThen(() => runCounted(input, deadline)),
            Effect.onExit(() =>
              admitted
                ? lifecyclePermit.withPermit(
                    Effect.gen(function* () {
                      if (onWindows) yield* reset;
                      else if (state.running === 1)
                        yield* Effect.sync(() => manager.cleanupAfterCommand());
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          state.running -= 1;
                          if (state.running === 0) {
                            state.idle?.resolve();
                            state.idle = null;
                          }
                        }),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          );
      });

    const run = (input: SandboxRun): Effect.Effect<SandboxResult, DesktopError> =>
      Effect.suspend(() => {
        const deadline = performance.now() + input.timeoutMs;
        const command = Effect.gen(function* () {
          yield* remaining(deadline);
          const available = yield* availability();
          if (available.kind !== "ready") {
            return yield* Effect.fail(
              unavailable("Commands are unavailable until the sandbox is set up."),
            );
          }
          return yield* commandSession(input, deadline);
        });
        return (onWindows ? withWindowsHost(command) : command).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(Math.max(0, input.timeoutMs)),
            orElse: () => Effect.fail(expired()),
          }),
        );
      });

    const changeNetwork = (grant: NetworkGrant, add: boolean): Effect.Effect<void, DesktopError> =>
      networkPermit.withPermit(
        lifecyclePermit.withPermit(
          // Once consent is given, a Stop or server switch must wait for the
          // file and proxy to agree rather than abandoning an in-flight write.
          Effect.uninterruptible(
            Effect.tryPromise({
              try: async () => {
                if (!grants) throw new Error("No network grant store is available.");
                const existed = grants.has(grant);
                if (add === existed) return;
                if (add) await grants.add(grant);
                else await grants.remove(grant);
                if (!state.config) return;
                const update = () => {
                  const config = { ...state.config!, network: policyWithGrants(grants).network };
                  manager.updateConfig(config);
                  state.config = config;
                };
                try {
                  update();
                } catch (cause) {
                  if (existed) await grants.add(grant);
                  else await grants.remove(grant);
                  update();
                  throw cause;
                }
              },
              catch: (cause) =>
                new DesktopError({
                  reason: "sandbox-unavailable",
                  message: `Could not change network access: ${String(cause)}`,
                }),
            }),
          ),
        ),
      );

    return Sandbox.of({
      availability,
      setUp,
      run,
      grants: () => Effect.sync(() => grants?.list() ?? []),
      approveNetwork: (grant) => changeNetwork(grant, true),
      revokeNetwork: (grant) => changeNetwork(grant, false),
    });
  });
