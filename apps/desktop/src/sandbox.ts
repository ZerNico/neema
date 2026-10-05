import { homedir, platform } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { Context, Effect, Layer, Semaphore } from "effect";
import { runOwnedProcess } from "./process.ts";
import { commandWithEnvironment, forSandboxedChild } from "./sandbox-environment.ts";
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
  inHome(".config", "pip"),
  inHome(".config", "uv"),
  // Rust, Go, Ruby, JVM
  inHome(".cargo"),
  inHome(".rustup"),
  inHome("go"),
  inHome(".go"),
  inHome(".gem"),
  inHome(".rbenv"),
  inHome(".sdkman"),
  inHome(".m2"),
  inHome(".gradle"),
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

/** Secrets that sit inside a re-allowed region above. A deeper deny wins in srt. */
const SECRETS_INSIDE_TOOLCHAINS = [
  inHome(".cache", "huggingface", "token"),
  inHome(".cache", "gh"),
  inHome(".config", "git", "credentials"),
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
    denyRead: [home, ...SECRETS_INSIDE_TOOLCHAINS],
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

/**
 * The manager is one per process, so its lifecycle is shared by every
 * service built over it: started once, reset when the last owner goes, and
 * never reset or set up while a command is running.
 */
interface ManagerState {
  started: boolean;
  owners: number;
  running: number;
}
const managerStates = new WeakMap<typeof SandboxManager, ManagerState>();
/** Guards start, reset and the Windows install against each other and against running commands. */
const lifecyclePermit = Semaphore.makeUnsafe(1);
const networkPermit = Semaphore.makeUnsafe(1);

export const makeSandbox = (
  manager = SandboxManager,
  execute = runOwnedProcess,
  grants: NetworkGrants | null = null,
) =>
  Effect.gen(function* () {
    const state = managerStates.get(manager) ?? { started: false, owners: 0, running: 0 };
    managerStates.set(manager, state);
    state.owners += 1;

    // `initialize` returns early whenever a previous call is in flight or
    // done. Approved destinations are loaded before this first start; later
    // changes update the full policy rather than re-initializing the proxy.
    const ensureStarted = lifecyclePermit.withPermit(
      Effect.suspend(() => {
        if (state.started) return Effect.void;
        return Effect.tryPromise({
          try: async () => {
            await manager.initialize(policyWithGrants(grants));
            state.started = true;
          },
          catch: (cause) =>
            new DesktopError({
              reason: "sandbox-unavailable",
              message: `Could not start the sandbox: ${String(cause)}`,
            }),
        });
      }),
    );

    // Waits for running commands to drain before touching shared state.
    const whenIdle = <A, E>(effect: Effect.Effect<A, E>) =>
      lifecyclePermit.withPermit(
        Effect.gen(function* () {
          while (state.running > 0) yield* Effect.sleep("50 millis");
          return yield* effect;
        }),
      );

    yield* Effect.addFinalizer(() =>
      whenIdle(
        Effect.promise(async () => {
          state.owners -= 1;
          if (state.owners === 0) {
            try {
              await manager.reset();
            } finally {
              state.started = false;
            }
          }
        }),
      ),
    );

    const availability = (): Effect.Effect<SandboxAvailability> =>
      Effect.gen(function* () {
        if (!manager.isSupportedPlatform()) {
          return {
            kind: "unsupported",
            reason: "Running commands needs macOS, Linux or Windows. WSL 1 is not supported.",
          } as const;
        }
        const check = yield* Effect.promise(() =>
          manager.checkDependenciesAsync().catch(() => ({
            errors: ["Could not check the sandbox requirements."],
            warnings: [] as string[],
          })),
        );
        if (check.errors.length === 0) return { kind: "ready" } as const;
        // Windows ships its own installer for exactly this, and it is the one
        // case the app can fix without sending the user to a terminal.
        if (platform() === "win32") {
          return { kind: "setup-needed", platform: "windows" } as const;
        }
        return {
          kind: "missing-deps",
          missing: check.errors,
          hint:
            platform() === "linux"
              ? "Install bubblewrap, socat and ripgrep, then check again."
              : "Install ripgrep, then check again.",
        } as const;
      });

    const setUp = (): Effect.Effect<SandboxAvailability> =>
      Effect.gen(function* () {
        if (platform() !== "win32") return yield* availability();
        // A cancelled elevation prompt is an ordinary outcome, not a fault:
        // re-reading availability puts the same Set up button back.
        const { installWindowsSandbox } = yield* Effect.promise(
          () => import("@anthropic-ai/sandbox-runtime"),
        );
        yield* Effect.promise(async () => {
          try {
            await installWindowsSandbox();
          } catch {
            /* availability() below reports the state that actually resulted */
          }
        });
        return yield* availability();
      }).pipe(whenIdle);

    const runCounted = (input: SandboxRun): Effect.Effect<SandboxResult, DesktopError> =>
      Effect.gen(function* () {
        const { argv, env } = yield* Effect.tryPromise({
          try: async () => {
            const wrapped = await manager.wrapWithSandboxArgv(
              commandWithEnvironment(input.command, input.cwd),
              undefined,
              // The grant, per call. The denies are repeated rather than
              // inherited so the one config a reader sees at the call site
              // is the whole filesystem policy.
              {
                filesystem: {
                  denyRead: GLOBAL_POLICY.filesystem.denyRead,
                  allowRead: [...TOOLCHAIN_READ, ...input.allowWrite],
                  allowWrite: [...input.allowWrite],
                  denyWrite: grants ? [grants.directory] : [],
                },
              },
              undefined,
              input.cwd,
              // Violations key on the first 100 characters of the command by
              // default, so two long commands sharing a prefix would report
              // each other's denials. The call id is unique by construction.
              { commandId: input.callId, commandText: input.command },
            );
            return { argv: forSandboxedChild(wrapped.argv, input.cwd), env: wrapped.env };
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
          timeoutMs: input.timeoutMs,
        });

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

    const run = (input: SandboxRun): Effect.Effect<SandboxResult, DesktopError> =>
      Effect.gen(function* () {
        const available = yield* availability();
        if (available.kind !== "ready") {
          return yield* Effect.fail(
            new DesktopError({
              reason: "sandbox-unavailable",
              message: "Commands are unavailable until the sandbox is set up.",
            }),
          );
        }
        yield* ensureStarted.pipe(Effect.uninterruptible);

        // Counted for the whole command, preparation included, so a reset,
        // the Windows install and the Linux mount cleanup all wait for it.
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            state.running += 1;
          }),
          () => runCounted(input),
          () =>
            Effect.sync(() => {
              state.running -= 1;
              // Tears down bwrap mount points on Linux, for the whole process;
              // running it under another command's feet would unmount its tree.
              if (state.running === 0) manager.cleanupAfterCommand();
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
                if (!state.started) return;
                try {
                  manager.updateConfig(policyWithGrants(grants));
                } catch (cause) {
                  if (existed) await grants.add(grant);
                  else await grants.remove(grant);
                  manager.updateConfig(policyWithGrants(grants));
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
