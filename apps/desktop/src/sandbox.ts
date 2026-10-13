import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  createEgressProxy,
  childEnvironment as proxyEnvironment,
  type EgressProxy,
} from "@chat/egress-proxy";
import {
  getPlatformSupport,
  spawn,
  type ContainerRequest,
  type NetworkPolicy,
  type PlatformSupport,
} from "@microsoft/mxc-sdk/v1";
import { Context, Duration, Effect, Layer } from "effect";
import {
  DesktopError,
  LIMITS,
  type NetworkGrant,
  type SandboxAvailability,
} from "@chat/desktop-rpc";
import {
  loadEgressGrants,
  type AnswerKey,
  type EgressGrant,
  type EgressGrants,
  type GrantTarget,
} from "./egress-grants.ts";
import { commandEnvironment } from "./sandbox-environment.ts";

const home = homedir();
const inHome = (...segments: string[]) => join(home, ...segments);

/**
 * Where toolchains keep what a build reads: version managers, package stores
 * and caches. The rest of the home directory stays unreadable, because a
 * command is driven by file contents the user did not write and the home
 * directory is where every CLI keeps its credentials.
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
  inHome(".local", "share", "fnm"),
  inHome(".local", "state", "fnm_multishells"),
  inHome("Library", "pnpm"),
  inHome("Library", "Application Support", "fnm"),
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

/**
 * Credential files inside the readable toolchain folders, or inside a folder
 * the person attached. A denied path outranks every grant in MXC.
 */
const CREDENTIAL_DENIES = [
  inHome(".cache", "huggingface", "token"),
  inHome(".cache", "gh"),
  inHome(".config", "git", "credentials"),
  inHome(".git-credentials"),
  inHome(".ssh"),
  inHome(".aws"),
  inHome(".gnupg"),
  inHome(".netrc"),
  inHome(".npmrc"),
  inHome(".pypirc"),
  inHome(".docker"),
  inHome(".kube"),
  inHome(".config", "gcloud"),
  inHome(".config", "gh"),
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
  inHome("Library", "Keychains"),
];

/** Where an operating system keeps what every program reads. */
const systemRead = (os: NodeJS.Platform): string[] => {
  if (os === "darwin")
    return [
      "/usr",
      "/bin",
      "/sbin",
      "/opt",
      "/System",
      "/Library",
      "/Applications",
      "/private/etc",
      "/private/var/db/timezone",
      "/private/var/select",
      "/dev",
    ];
  if (os === "win32") {
    const root = process.env.SYSTEMROOT ?? "C:\\Windows";
    return [
      root,
      process.env.PROGRAMFILES ?? "C:\\Program Files",
      process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
      process.env.PROGRAMDATA ?? "C:\\ProgramData",
    ];
  }
  return ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/nix", "/snap"];
};

/**
 * Per-user folders macOS hands to developer tools through confstr, ignoring
 * TMPDIR. git and xcrun fail to start without them. They hold only this user's
 * temporary and cache files.
 */
const macUserFolders = (): string[] => {
  try {
    return ["DARWIN_USER_TEMP_DIR", "DARWIN_USER_CACHE_DIR"].map((name) =>
      execFileSync("/usr/bin/getconf", [name], { encoding: "utf8" }).trim(),
    );
  } catch {
    return [];
  }
};

export interface PolicyInput {
  readonly os: NodeJS.Platform;
  /** Every attached folder's real root and the chat's workspace: the only writable places. */
  readonly writable: ReadonlyArray<string>;
  /** The profile's permission store, which no command may read or change. */
  readonly protectedDirectory: string | null;
  readonly userFolders: ReadonlyArray<string>;
}

/** Read the system and toolchains, write the attached folders, never touch credentials. */
export const filesystemPolicy = (input: PolicyInput) => ({
  readwritePaths: [
    ...input.writable,
    ...input.userFolders,
    ...(input.os === "win32" ? [] : ["/dev/null"]),
  ],
  readonlyPaths: [...systemRead(input.os), ...TOOLCHAIN_READ],
  deniedPaths: [
    ...CREDENTIAL_DENIES,
    ...(input.protectedDirectory ? [input.protectedDirectory] : []),
  ],
});

/**
 * Only the egress proxy is reachable. Windows can only bind an unpackaged
 * proxy by opening host loopback; there the proxy's token is what keeps
 * commands from one another's grants.
 */
const networkPolicy = (os: NodeJS.Platform, proxyUrl: string): NetworkPolicy => ({
  egress: { default: "deny" },
  ingress:
    os === "win32"
      ? { default: "allow", hostLoopback: "allow" }
      : { default: "deny", hostLoopback: "deny" },
  runtimeConfig: { networkProxy: proxyUrl },
});

const shellCommand = (command: string, os: NodeJS.Platform) =>
  os === "win32"
    ? `cmd.exe /d /s /c "${command}"`
    : `/bin/sh -c '${command.replaceAll("'", "'\\''")}'`;

export interface SandboxContext {
  readonly origin: string;
  readonly conversationId: string;
  /** The answer generating this command; grants scoped to it end with it. */
  readonly attempt: string;
}

export interface SandboxRun {
  readonly callId: string;
  readonly command: string;
  readonly context: SandboxContext;
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

/** The slice of an MXC process the sandbox drives, so tests can stand in for it. */
export interface LaunchedProcess {
  readonly standardOutput: Readable | null;
  readonly standardError: Readable | null;
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  kill(): void;
}

export interface SandboxDependencies {
  readonly os: NodeJS.Platform;
  readonly support: () => PlatformSupport;
  readonly launch: (request: ContainerRequest) => Promise<LaunchedProcess>;
  readonly grants: EgressGrants | null;
  readonly userFolders: () => ReadonlyArray<string>;
}

export class Sandbox extends Context.Service<
  Sandbox,
  {
    availability(): Effect.Effect<SandboxAvailability>;
    /** Nothing to install: re-reports availability. */
    setUp(): Effect.Effect<SandboxAvailability>;
    run(input: SandboxRun): Effect.Effect<SandboxResult, DesktopError>;
    /** Websites allowed for every chat, as Settings lists them. */
    grants(): Effect.Effect<readonly NetworkGrant[]>;
    /** Records approved access. The grant must already be canonical. */
    approveNetwork(target: GrantTarget, grant: EgressGrant): Effect.Effect<void, DesktopError>;
    /** Removes access and closes the tunnels it allowed. */
    revokeNetwork(target: GrantTarget, grant: EgressGrant): Effect.Effect<void, DesktopError>;
    /** Ends this server's answer grants for every answer not listed as running. */
    keepAnswers(origin: string, live: readonly AnswerKey[]): Effect.Effect<void>;
  }
>()("desktop/Sandbox") {
  static readonly layerAt = (directory: string) =>
    Layer.effect(
      Sandbox,
      Effect.flatMap(
        Effect.promise(() => loadEgressGrants(directory)),
        (grants) =>
          makeSandbox({
            os: platform(),
            support: getPlatformSupport,
            launch: spawn,
            grants,
            userFolders: () => (platform() === "darwin" ? macUserFolders() : []),
          }),
      ),
    );
}

const unavailable = (message: string) =>
  new DesktopError({ reason: "sandbox-unavailable", message });
const expired = () =>
  new DesktopError({ reason: "timed-out", message: "The command’s time limit was reached." });

/** Keeps the first `limit` characters across both streams and drains the rest. */
const collect = (streams: ReadonlyArray<Readable | null>, limit: number) => {
  const chunks: string[] = [];
  let kept = 0;
  let seen = 0;
  const done = streams.map(
    (stream) =>
      new Promise<void>((resolve) => {
        if (!stream) return resolve();
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          seen += chunk.length;
          if (kept >= limit) return;
          const piece = chunk.slice(0, limit - kept);
          chunks.push(piece);
          kept += piece.length;
        });
        stream.once("end", () => resolve());
        stream.once("close", () => resolve());
        stream.once("error", () => resolve());
      }),
  );
  return {
    finished: Promise.all(done),
    result: () => ({ output: chunks.join(""), truncated: seen > kept }),
  };
};

/** One line per refused tunnel, in the form the site reads to offer access. */
const violationLine = (host: string, port: number) => `deny network-outbound ${host}:${port}`;

export const makeSandbox = (dependencies: SandboxDependencies) =>
  Effect.gen(function* () {
    const { os, grants } = dependencies;
    const denials = new Map<string, string[]>();
    const running = new Set<LaunchedProcess>();
    let closed = false;

    const proxy: EgressProxy = createEgressProxy({
      decide: (context, host, port) =>
        grants ? grants.decide(context, host, port) : { allowed: false, reason: "No grants" },
      onDenial: ({ context, host, port }) => {
        const lines = denials.get(context.command);
        if (lines && lines.length < 20) lines.push(violationLine(host, port));
      },
    });
    yield* Effect.promise(() => proxy.listen());

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closed = true;
        for (const process of running) process.kill();
        await proxy.close();
      }),
    );

    const availability = (): Effect.Effect<SandboxAvailability> =>
      Effect.sync(() => {
        if (closed) return { kind: "unsupported", reason: "The sandbox is closing." } as const;
        let support: PlatformSupport;
        try {
          support = dependencies.support();
        } catch {
          return {
            kind: "unsupported",
            reason: "Could not check the sandbox requirements.",
          } as const;
        }
        if (support.isSupported && support.availableMethods.length > 0)
          return { kind: "ready" } as const;
        return {
          kind: "unsupported",
          reason: support.reason || "Running commands is not supported on this computer.",
        } as const;
      });

    const run = (input: SandboxRun): Effect.Effect<SandboxResult, DesktopError> =>
      Effect.gen(function* () {
        const available = yield* availability();
        if (available.kind !== "ready") {
          return yield* Effect.fail(
            unavailable(available.kind === "unsupported" ? available.reason : "Unavailable."),
          );
        }
        const { token, proxyUrl } = proxy.issue({
          server: input.context.origin,
          chat: input.context.conversationId,
          attempt: input.context.attempt,
          command: input.callId,
        });
        denials.set(input.callId, []);
        const forget = Effect.sync(() => {
          // Ends every tunnel the command opened, and its leftover children's.
          proxy.revoke(token);
          denials.delete(input.callId);
        });
        const request: ContainerRequest = {
          command: shellCommand(input.command, os),
          workingDirectory: input.cwd,
          environment: commandEnvironment(process.env, input.cwd, proxyEnvironment(proxyUrl), os),
          filesystem: filesystemPolicy({
            os,
            writable: input.allowWrite,
            protectedDirectory: grants?.directory ?? null,
            userFolders: dependencies.userFolders(),
          }),
          network: networkPolicy(os, proxyUrl),
          timeoutMs: input.timeoutMs,
        };
        const finished = yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () => dependencies.launch(request),
            catch: (cause) => unavailable(`Could not start the command: ${String(cause)}`),
          }).pipe(Effect.tap((child) => Effect.sync(() => running.add(child)))),
          (child) =>
            Effect.promise(async () => {
              const output = collect(
                [child.standardOutput, child.standardError],
                LIMITS.outputChars,
              );
              const [exit] = await Promise.all([child.wait(), output.finished]);
              return {
                ...exit,
                ...output.result(),
                violations: [...(denials.get(input.callId) ?? [])],
              };
            }),
          // Stop and the deadline land here: the process tree goes with the command.
          (child) =>
            Effect.sync(() => {
              running.delete(child);
              child.kill();
            }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(Math.max(0, input.timeoutMs)),
            orElse: () => Effect.fail(expired()),
          }),
          Effect.ensuring(forget),
        );
        if (finished.timedOut) {
          return yield* Effect.fail(
            new DesktopError({
              reason: "timed-out",
              message: `The command was still running after ${Math.round(input.timeoutMs / 1000)}s and was stopped.`,
            }),
          );
        }
        return {
          exitCode: finished.exitCode,
          output: finished.output,
          truncated: finished.truncated,
          violations: finished.violations,
        };
      });

    const always = { scope: "always" } as const;
    const changeNetwork = (
      target: GrantTarget,
      grant: EgressGrant,
      add: boolean,
    ): Effect.Effect<void, DesktopError> =>
      Effect.tryPromise({
        try: async () => {
          if (!grants) throw new Error("No network grant store is available.");
          if (add) await grants.add(target, grant);
          else proxy.regrant(await grants.remove(target, grant));
        },
        catch: (cause) =>
          new DesktopError({
            reason: "sandbox-unavailable",
            message: `Could not change network access: ${String(cause)}`,
          }),
      }).pipe(Effect.uninterruptible);

    return Sandbox.of({
      availability,
      setUp: availability,
      run,
      grants: () =>
        Effect.sync(
          () =>
            grants
              ?.list(always)
              .filter((grant) => grant.port === 443 && !grant.privateNetwork)
              .map(({ host }) => ({ host })) ?? [],
        ),
      approveNetwork: (target, grant) => changeNetwork(target, grant, true),
      revokeNetwork: (target, grant) => changeNetwork(target, grant, false),
      keepAnswers: (origin, live) =>
        Effect.sync(() => {
          for (const id of grants?.keepAnswers(origin, live) ?? []) proxy.regrant(id);
        }),
    });
  });
