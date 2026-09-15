import { homedir, platform } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { Context, Effect, Layer, Semaphore } from "effect";
import { runOwnedProcess } from "./process.ts";
import { DesktopError, LIMITS, type SandboxAvailability } from "@chat/desktop-rpc";

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
 * Network is one policy for the machine, set once here. srt keeps a single
 * proxy per process and reads this list live, which is why the level is not
 * a per-chat choice: two chats with different levels would need two proxies.
 *
 * Not user-editable in v1. A settings screen for this would be a way to talk
 * someone into disabling their own sandbox.
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
  },
};

/**
 * Two things srt gets wrong for real tools on macOS, fixed on the argv it
 * hands back. That argv is `bash -c "env VAR=... sandbox-exec ... <cmd>"`,
 * one shell string, so the rewrite is over the assignments in that string.
 *
 * srt hands the child `HTTPS_PROXY=http://localhost:PORT`, but its Seatbelt
 * profile denies the resolver lookup that `getaddrinfo("localhost")` needs,
 * so anything resolving the name properly (Python's urllib3, so pip) fails
 * with "nodename nor servname provided" before it ever reaches the proxy.
 * curl and npm happen to special-case the name. The numeric loopback address
 * needs no lookup and is what the profile actually allows.
 *
 * And pip's cache lives under `~/Library/Caches`, outside the only writable
 * path, so every install warns and then retries the network for nothing.
 * Pointing the cache inside the folder keeps installs quiet and fast.
 */
const PROXY_URL_VAR =
  /\b((?:[A-Z_]*_PROXY|[a-z_]*_proxy)=[a-z0-9+]+:\/\/(?:[^@\s]*@)?)localhost(?=:\d)/g;
const PROXY_HOST_VAR = /\b(CLOUDSDK_PROXY_ADDRESS=|RSYNC_PROXY=)localhost\b/g;

export const forSandboxedChild = (argv: readonly string[], cwd: string): string[] =>
  argv.map((arg, index) => {
    if (index === 0 || !arg.startsWith("env ")) return arg;
    // Match shell words only in env's leading assignment list. The executable,
    // profile and user script are an opaque suffix, including proxy-looking text.
    const assignments =
      /^env\s+((?:[A-Za-z_][A-Za-z_0-9]*=(?:[^\s'"\\;|&<>`()]+|'[^']*'|"(?:[^"\\]|\\.)*"|\\.)*(?:\s+|$))*)/.exec(
        arg,
      );
    if (!assignments) return arg;
    const prefix = assignments[0];
    const rewritten = prefix
      .replaceAll(PROXY_URL_VAR, (_match, name: string) => `${name}127.0.0.1`)
      .replaceAll(PROXY_HOST_VAR, (_match, name: string) => `${name}127.0.0.1`);
    const withCache = /(?:^|\s)PIP_CACHE_DIR=/.test(assignments[1] ?? "")
      ? rewritten
      : rewritten.replace(
          /^env /,
          () => `env PIP_CACHE_DIR=${shellQuote(join(cwd, ".cache", "pip"))} `,
        );
    return withCache + arg.slice(prefix.length);
  });

/** Single-quoted for the `bash -c` string; a folder name may hold anything. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
  }
>()("desktop/Sandbox") {
  static readonly layer = Layer.effect(
    Sandbox,
    Effect.suspend(() => makeSandbox()),
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

export const makeSandbox = (manager = SandboxManager, execute = runOwnedProcess) =>
  Effect.gen(function* () {
    const state = managerStates.get(manager) ?? { started: false, owners: 0, running: 0 };
    managerStates.set(manager, state);
    state.owners += 1;

    // `initialize` returns early whenever a previous call is in flight or
    // done, *before* it stores the new config, so it is called exactly once
    // per process with the whole policy. The folders are the only per-call
    // part and travel through `wrapWithSandboxArgv`.
    const ensureStarted = lifecyclePermit.withPermit(
      Effect.suspend(() => {
        if (state.started) return Effect.void;
        return Effect.tryPromise({
          try: async () => {
            await manager.initialize(GLOBAL_POLICY);
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
          try: () =>
            manager.wrapWithSandboxArgv(
              input.command,
              undefined,
              // The grant, per call. The denies are repeated rather than
              // inherited so the one config a reader sees at the call site
              // is the whole filesystem policy.
              {
                filesystem: {
                  denyRead: GLOBAL_POLICY.filesystem.denyRead,
                  allowRead: [...TOOLCHAIN_READ, ...input.allowWrite],
                  allowWrite: [...input.allowWrite],
                  denyWrite: [],
                },
              },
              undefined,
              input.cwd,
              // Violations key on the first 100 characters of the command by
              // default, so two long commands sharing a prefix would report
              // each other's denials. The call id is unique by construction.
              { commandId: input.callId, commandText: input.command },
            ),
          catch: (cause) =>
            new DesktopError({
              reason: "sandbox-unavailable",
              message: `Could not prepare the command: ${String(cause)}`,
            }),
        }).pipe(Effect.uninterruptible);

        const [program, ...args] = forSandboxedChild(argv, input.cwd);
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

        // Turns bare EPERMs into sentences naming what was blocked. Empty on
        // Linux, which reports no violations at all, so silence here never
        // means nothing was denied.
        const annotated = manager.annotateStderrWithSandboxFailures(input.callId, finished.stderr);
        const violations = annotated === finished.stderr ? [] : [annotated.slice(0, 2_000)];

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

    return Sandbox.of({ availability, setUp, run });
  });
