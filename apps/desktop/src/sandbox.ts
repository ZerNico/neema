import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { Context, Effect, Layer } from "effect";
import {
  DesktopError,
  LIMITS,
  type NetworkLevel,
  type SandboxAvailability,
} from "@chat/desktop-rpc";

/**
 * Everything a command may never touch, whatever folder is attached.
 *
 * Reads are deny-then-allow in srt, so denying these regions still leaves the
 * rest of the disk readable; that is deliberate, since a build reads compilers
 * and caches all over the machine. Writes are allow-only and this config lists
 * none, so the *only* writable place is the folder passed per call.
 *
 * Not user-editable in v1. A settings screen for this would be a way to talk
 * someone into disabling their own sandbox.
 */
const GLOBAL_POLICY: SandboxRuntimeConfig = {
  filesystem: {
    denyRead: [
      join(homedir(), ".ssh"),
      join(homedir(), ".aws"),
      join(homedir(), ".gnupg"),
      join(homedir(), ".config", "gh"),
      join(homedir(), ".npmrc"),
      join(homedir(), ".netrc"),
      join(homedir(), ".kube"),
    ],
    allowRead: [],
    // Filled per call with the attached folder; empty here means no writes.
    allowWrite: [],
    denyWrite: [],
  },
  network: {
    // The `packages` level, and the baseline `initialize` is given. `none`
    // and `all` are per-call overrides in `run`.
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
    // Only the `env ...` script is rewritten, never the user's command inside
    // it; the command is the last argument of the inner `bash -c`, which the
    // proxy patterns cannot match because they anchor on a VAR= prefix.
    if (index === 0 || !arg.startsWith("env ")) return arg;
    const rewritten = arg
      .replaceAll(PROXY_URL_VAR, "$1127.0.0.1")
      .replaceAll(PROXY_HOST_VAR, "$1127.0.0.1");
    return rewritten.includes(" PIP_CACHE_DIR=")
      ? rewritten
      : rewritten.replace(/^env /, `env PIP_CACHE_DIR=${shellQuote(join(cwd, ".cache", "pip"))} `);
  });

/** Single-quoted for the `bash -c` string; a folder name may hold anything. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export interface SandboxRun {
  readonly callId: string;
  readonly command: string;
  /** Already resolved and proven inside the folder by `resolveInFolder`. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly network: NetworkLevel;
}

/**
 * What each level hands srt per call. `all` is spelled as a wildcard rather
 * than an absent allowlist, because an absent one falls back to the global
 * `packages` policy field by field.
 */
const networkFor = (level: NetworkLevel): SandboxRuntimeConfig["network"] =>
  level === "none"
    ? { allowedDomains: [], deniedDomains: [] }
    : level === "all"
      ? { allowedDomains: ["*"], deniedDomains: [] }
      : GLOBAL_POLICY.network;

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
    Effect.gen(function* () {
      /**
       * Initialised once, with the global policy only. `initialize` returns
       * early whenever a previous call is in flight or done, *before* it stores
       * the new config, so a second call with a different policy silently keeps
       * the old one. Reconfiguring means `reset` plus `initialize`, which drops
       * the proxies mid-session. Hence: global denies here, the folder per call.
       */
      let started = false;
      const ensureStarted = Effect.suspend(() => {
        if (started) return Effect.void;
        started = true;
        return Effect.tryPromise({
          try: () => SandboxManager.initialize(GLOBAL_POLICY),
          catch: (cause) =>
            new DesktopError({
              reason: "sandbox-unavailable",
              message: `Could not start the sandbox: ${String(cause)}`,
            }),
        });
      });

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => SandboxManager.reset().catch(() => {})),
      );

      const availability = (): Effect.Effect<SandboxAvailability> =>
        Effect.gen(function* () {
          if (!SandboxManager.isSupportedPlatform()) {
            return {
              kind: "unsupported",
              reason: "Running commands needs macOS, Linux or Windows. WSL 1 is not supported.",
            } as const;
          }
          const check = yield* Effect.promise(() =>
            SandboxManager.checkDependenciesAsync().catch(() => ({
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
        });

      const run = (input: SandboxRun): Effect.Effect<SandboxResult, DesktopError> =>
        Effect.gen(function* () {
          const state = yield* availability();
          if (state.kind !== "ready") {
            return yield* Effect.fail(
              new DesktopError({
                reason: "sandbox-unavailable",
                message: "Commands are unavailable until the sandbox is set up.",
              }),
            );
          }
          yield* ensureStarted;
          // The per-call override below shapes the Seatbelt profile, but the
          // proxy that answers CONNECTs reads the manager's own config. Both
          // have to agree, so the level is applied there first.
          yield* Effect.sync(() =>
            SandboxManager.updateConfig({ ...GLOBAL_POLICY, network: networkFor(input.network) }),
          );

          const { argv, env } = yield* Effect.tryPromise({
            try: () =>
              SandboxManager.wrapWithSandboxArgv(
                input.command,
                undefined,
                // The grant, per call. It cannot go in the global config
                // because that one is frozen after the first initialize. The
                // denies are repeated rather than inherited so the one config
                // a reader sees at the call site is the whole policy.
                {
                  filesystem: {
                    denyRead: GLOBAL_POLICY.filesystem.denyRead,
                    allowWrite: [input.cwd],
                    denyWrite: [],
                  },
                  network: networkFor(input.network),
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
          });

          const [program, ...args] = forSandboxedChild(argv, input.cwd);
          if (!program) {
            return yield* Effect.fail(
              new DesktopError({ reason: "failed", message: "The command was empty." }),
            );
          }

          const finished = yield* Effect.tryPromise({
            try: () =>
              new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>(
                (settle) => {
                  // `shell: false` is the security boundary: the wrapped argv
                  // never reaches a host shell for re-parsing.
                  const child = spawn(program, args, { cwd: input.cwd, env, shell: false });
                  let stdout = "";
                  let stderr = "";
                  let timedOut = false;
                  const timer = setTimeout(() => {
                    timedOut = true;
                    child.kill("SIGKILL");
                  }, input.timeoutMs);
                  child.stdout?.on("data", (chunk: Buffer) => {
                    if (stdout.length < LIMITS.outputChars) stdout += chunk.toString("utf8");
                  });
                  child.stderr?.on("data", (chunk: Buffer) => {
                    if (stderr.length < LIMITS.outputChars) stderr += chunk.toString("utf8");
                  });
                  child.on("error", () => {
                    clearTimeout(timer);
                    settle({ code: -1, stdout, stderr, timedOut });
                  });
                  child.on("close", (code) => {
                    clearTimeout(timer);
                    settle({ code: code ?? -1, stdout, stderr, timedOut });
                  });
                },
              ),
            catch: (cause) =>
              new DesktopError({ reason: "failed", message: `Could not run it: ${String(cause)}` }),
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
          const annotated = SandboxManager.annotateStderrWithSandboxFailures(
            input.callId,
            finished.stderr,
          );
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

      return Sandbox.of({ availability, setUp, run });
    }),
  );
}
