import { execFileSync } from "node:child_process";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import type { Readable } from "node:stream";
import {
  createEgressProxy,
  childEnvironment as proxyEnvironment,
  type EgressProxy,
} from "@chat/egress-proxy";
import {
  getAvailableBackends,
  getPlatformSupport,
  spawn,
  type AvailableBackend,
  type ContainerRequest,
  type NetworkPolicy,
  type PlatformSupport,
} from "@microsoft/mxc-sdk/v1";
import { Context, Duration, Effect, Layer } from "effect";
import { DesktopError, LIMITS, type SandboxAvailability } from "@chat/desktop-rpc";
import {
  loadEgressGrants,
  type AnswerKey,
  type ChatKey,
  type EgressGrant,
  type EgressGrants,
  type GrantTarget,
} from "./egress-grants.ts";
import { checkPathGrant, loadPathGrants, type PathGrants } from "./path-grants.ts";
import { loadScopedGrants, type ScopedGrants } from "./scoped-grants.ts";
import { commandEnvironment, jvmEnvironment, mavenSettings } from "./sandbox-environment.ts";
import { appBundle, findSsh, writeSshSetup, type SshSetup } from "./ssh-setup.ts";

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
 * Where Windows installers and version managers put toolchains for one user,
 * outside the dot-folders above: AppData and scoop.
 */
const windowsToolchainRead = (env: NodeJS.ProcessEnv) => {
  const roaming = env.APPDATA ?? inHome("AppData", "Roaming");
  const local = env.LOCALAPPDATA ?? inHome("AppData", "Local");
  return [
    join(roaming, "npm"),
    join(roaming, "nvm"),
    join(roaming, "fnm"),
    join(roaming, "uv"),
    join(local, "fnm_multishells"),
    join(local, "pnpm"),
    join(local, "Volta"),
    join(local, "Yarn"),
    join(local, "Programs", "Python"),
    join(local, "Programs", "Git"),
    join(local, "Microsoft", "WinGet", "Packages"),
    join(local, "Microsoft", "WinGet", "Links"),
    inHome("scoop"),
  ];
};

/**
 * Credential files inside the readable toolchain folders, or inside a folder
 * the person attached. A denied path outranks every grant in MXC.
 */
export const CREDENTIAL_DENIES = [
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
  /** Paths the person let this answer's commands read. */
  readonly readable: ReadonlyArray<string>;
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
  readonlyPaths: [
    ...systemRead(input.os),
    ...TOOLCHAIN_READ,
    ...(input.os === "win32" ? windowsToolchainRead(process.env) : []),
    ...input.readable,
  ],
  deniedPaths: [
    ...CREDENTIAL_DENIES,
    ...(input.protectedDirectory ? [input.protectedDirectory] : []),
  ],
});

type FilesystemPolicy = ReturnType<typeof filesystemPolicy>;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Windows refuses a whole policy naming a path that does not exist, where the
 * other backends skip it. A missing denied path is safe to drop: nothing can
 * create it except inside a writable folder, as the command's own file.
 */
const existingOnly = async (policy: FilesystemPolicy): Promise<FilesystemPolicy> => {
  const keep = async (paths: readonly string[]) => {
    const present = await Promise.all(paths.map(exists));
    return paths.filter((_, index) => present[index]);
  };
  const [readwritePaths, readonlyPaths, deniedPaths] = await Promise.all([
    keep(policy.readwritePaths),
    keep(policy.readonlyPaths),
    keep(policy.deniedPaths),
  ]);
  return { readwritePaths, readonlyPaths, deniedPaths };
};

/**
 * Every folder above an allowed path, which a Windows command may query and
 * list but not read: names in those folders, never their files' contents.
 */
export const enumerableAncestors = (paths: readonly string[]) => {
  const allowed = new Set(paths);
  const ancestors = new Set<string>();
  for (const path of paths) {
    for (let parent = win32.dirname(path); !ancestors.has(parent); parent = win32.dirname(parent)) {
      if (!allowed.has(parent)) ancestors.add(parent);
      if (win32.dirname(parent) === parent) break;
    }
  }
  return [...ancestors];
};

/**
 * Outbound goes only to the egress proxy. Local services, a grant of their own,
 * open loopback both ways: Seatbelt has no private loopback, so a command
 * talking to itself (Gradle's daemon, a test server) needs the host's, and the
 * inbound half cannot be scoped by address. Windows proxy mode allows no
 * loopback but the proxy, not even a command's own listener, so there the
 * grant leaves proxy mode: loopback opens, direct egress stays denied, and the
 * proxy variables the command already has reach the proxy as a host service.
 */
export const networkPolicy = (
  os: NodeJS.Platform,
  proxyUrl: string,
  local: boolean,
): NetworkPolicy =>
  os === "win32" && local
    ? { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" } }
    : {
        egress: { default: "deny" },
        ingress:
          os === "win32" || local
            ? { default: "allow", hostLoopback: "allow" }
            : { default: "deny", hostLoopback: "deny" },
        runtimeConfig: { networkProxy: proxyUrl },
      };

/**
 * Switches a person grants commands, in the same scopes as other grants:
 * local network services, and signing in through their SSH agent (chat only).
 */
export type Capability = "local-services" | "ssh-agent";
const CAPABILITIES: ReadonlySet<string> = new Set<Capability>(["local-services", "ssh-agent"]);

/** Puts the ssh wrapper first, so ssh, git, scp and rsync all go through the proxy. */
const withSsh = (
  environment: Record<string, string>,
  ssh: SshSetup | null,
  agent: string | null,
) =>
  ssh
    ? {
        ...environment,
        PATH: [ssh.bin, environment.PATH].filter(Boolean).join(delimiter),
        // ssh-add and other agent clients read the socket from here.
        ...(agent ? { SSH_AUTH_SOCK: agent } : {}),
      }
    : environment;

const shellCommand = (command: string, os: NodeJS.Platform) =>
  os === "win32"
    ? `cmd.exe /d /s /c "${command}"`
    : `/bin/sh -c '${command.replaceAll("'", "'\\''")}'`;

export interface Permissions {
  readonly network: readonly EgressGrant[];
  readonly paths: readonly string[];
  /** Switches granted: local network services, the SSH agent. */
  readonly capabilities: readonly Capability[];
}

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
  readonly backends: () => readonly AvailableBackend[];
  readonly launch: (request: ContainerRequest) => Promise<LaunchedProcess>;
  readonly grants: EgressGrants | null;
  readonly paths: PathGrants | null;
  readonly capabilities: ScopedGrants | null;
  /** The user's SSH agent socket, if they run one. */
  readonly agent: string | null;
  readonly userFolders: () => ReadonlyArray<string>;
}

export class Sandbox extends Context.Service<
  Sandbox,
  {
    availability(): Effect.Effect<SandboxAvailability>;
    /** Nothing to install: re-reports availability. */
    setUp(): Effect.Effect<SandboxAvailability>;
    run(input: SandboxRun): Effect.Effect<SandboxResult, DesktopError>;
    /** What one scope allows, for Settings (always) and a chat's own list. */
    permissions(target: GrantTarget): Effect.Effect<Permissions>;
    /** A chat is gone for good: its grants, and its answers', go too. */
    forgetChat(chat: ChatKey): Effect.Effect<void>;
    /** Records approved access. The grant must already be canonical. */
    approveNetwork(target: GrantTarget, grant: EgressGrant): Effect.Effect<void, DesktopError>;
    /** Removes access and closes the tunnels it allowed. */
    revokeNetwork(target: GrantTarget, grant: EgressGrant): Effect.Effect<void, DesktopError>;
    /** Ends this server's answer grants for every answer not listed as running. */
    keepAnswers(origin: string, live: readonly AnswerKey[]): Effect.Effect<void>;
    /** Lets commands read one more path; resolves to the real path granted. */
    approvePath(target: GrantTarget, path: string): Effect.Effect<string, DesktopError>;
    revokePath(target: GrantTarget, path: string): Effect.Effect<void, DesktopError>;
    /** Grants a switch, from the commands' next run. The SSH agent is per chat only. */
    approveCapability(
      target: GrantTarget,
      capability: Capability,
    ): Effect.Effect<void, DesktopError>;
    revokeCapability(
      target: GrantTarget,
      capability: Capability,
    ): Effect.Effect<void, DesktopError>;
  }
>()("desktop/Sandbox") {
  static readonly layerAt = (directory: string) =>
    Layer.effect(
      Sandbox,
      Effect.flatMap(
        Effect.promise(() =>
          Promise.all([
            loadEgressGrants(directory),
            loadPathGrants(directory, { home, denied: [...CREDENTIAL_DENIES, directory] }),
            loadScopedGrants(directory, "capability-grants.json", (entry) =>
              CAPABILITIES.has(entry),
            ),
          ]),
        ),
        ([grants, paths, capabilities]) =>
          makeSandbox({
            os: platform(),
            support: getPlatformSupport,
            backends: getAvailableBackends,
            launch: spawn,
            grants,
            paths,
            capabilities,
            agent: process.env.SSH_AUTH_SOCK ?? null,
            userFolders: () => (platform() === "darwin" ? macUserFolders() : []),
          }),
      ),
    );
}

/**
 * What a Windows container needs from the host. An unpackaged proxy is
 * reachable only through host loopback, and Node, npm and git fail unless the
 * folders above their own can be queried (`enumeratePaths`). Builds without
 * Process Security Environment 1.1 refuse both for every command. MXC after
 * 1.0.0 also reports `identitylessLoopbackProxy` for older hosts it can serve
 * a proxy on; reconsider on a bump.
 */
const WINDOWS_NEEDS = ["ingressHostLoopbackAllow", "filesystemEnumeratePaths"] as const;
const windowsReady = (backends: readonly AvailableBackend[]) =>
  backends.some(
    (backend) =>
      backend.backend === "processcontainer" &&
      WINDOWS_NEEDS.every((need) => backend.capabilities.includes(need)),
  );

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
        let backends: readonly AvailableBackend[];
        try {
          support = dependencies.support();
          backends = os === "win32" ? dependencies.backends() : [];
        } catch {
          return {
            kind: "unsupported",
            reason: "Could not check the sandbox requirements.",
          } as const;
        }
        if (!support.isSupported || support.availableMethods.length === 0)
          return {
            kind: "unsupported",
            reason: support.reason || "Running commands is not supported on this computer.",
          } as const;
        if (os === "win32" && !windowsReady(backends))
          return {
            kind: "unsupported",
            reason: "Commands need a newer Windows build. Install the latest Windows updates.",
          } as const;
        return { kind: "ready" } as const;
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
        // Holds the Maven settings (token included) and the ssh setup: private, readable, and gone
        // with the command.
        const commandDirectory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "neema-command-")),
        );
        const settingsFile = join(commandDirectory, "settings.xml");
        const cache = join(input.cwd, ".cache");
        yield* Effect.promise(() =>
          writeFile(settingsFile, mavenSettings(proxyUrl, join(cache, "m2")), { mode: 0o600 }),
        );
        const granted = new Set(dependencies.capabilities?.applying(input.context) ?? []);
        const agent = granted.has("ssh-agent") ? dependencies.agent : null;
        const ssh =
          os === "win32"
            ? null
            : yield* Effect.promise(async () => {
                const binary = await findSsh(process.env.PATH, async (file) =>
                  access(file, constants.X_OK).then(
                    () => true,
                    () => false,
                  ),
                );
                return binary
                  ? writeSshSetup({
                      directory: commandDirectory,
                      ssh: binary,
                      node: process.execPath,
                      knownHosts: join(home, ".ssh", "known_hosts"),
                      agent,
                    })
                  : null;
              });
        const removeSettings = Effect.promise(() =>
          rm(commandDirectory, { recursive: true, force: true }),
        );
        const environment = withSsh(
          commandEnvironment(
            process.env,
            input.cwd,
            {
              ...proxyEnvironment(proxyUrl),
              ...jvmEnvironment(proxyUrl, cache, settingsFile, os),
            },
            os,
          ),
          ssh,
          agent,
        );
        const filesystem = yield* Effect.promise(async () => {
          const policy = filesystemPolicy({
            os,
            // The command's own folder: ssh records host keys there. The agent's socket, when the
            // chat allows it: connecting needs it writable.
            writable: [...input.allowWrite, commandDirectory, ...(agent ? [agent] : [])],
            readable: [
              ...(dependencies.paths?.applying(input.context) ?? []),
              // The ssh bridge runs on the app's own executable.
              ...(ssh ? [appBundle(process.execPath)] : []),
            ],
            protectedDirectory: grants?.directory ?? null,
            userFolders: dependencies.userFolders(),
          });
          return os === "win32" ? existingOnly(policy) : policy;
        });
        const request: ContainerRequest = {
          command: shellCommand(input.command, os),
          workingDirectory: input.cwd,
          environment,
          filesystem,
          // Seatbelt blocks directory services, and ssh refuses to start when it cannot
          // name the current user; this one lookup answers that and nothing more.
          ...(os === "darwin"
            ? {
                containment: {
                  type: "seatbelt" as const,
                  config: { extraMachLookups: ["com.apple.system.opendirectoryd.libinfo"] },
                },
              }
            : {}),
          // Node's realpath, npm and git stat every folder above the one they run in.
          ...(os === "win32"
            ? {
                containment: {
                  type: "processcontainer" as const,
                  config: {
                    filesystem: {
                      enumeratePaths: enumerableAncestors([
                        ...filesystem.readwritePaths,
                        ...filesystem.readonlyPaths,
                      ]),
                    },
                  },
                },
              }
            : {}),
          // MXC's default disables Win32k, and every program linking user32 (PowerShell, git,
          // where, whoami) then dies at load with no output. Clipboard and input stay denied.
          ...(os === "win32"
            ? { ui: { disable: false, clipboard: "none" as const, allowInputInjection: false } }
            : {}),
          network: networkPolicy(os, proxyUrl, granted.has("local-services")),
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
          Effect.ensuring(Effect.andThen(forget, removeSettings)),
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

    // Applies from the next command: a running one keeps the policy it started with.
    const changeCapability = (
      target: GrantTarget,
      capability: Capability,
      add: boolean,
    ): Effect.Effect<void, DesktopError> =>
      Effect.tryPromise({
        try: async () => {
          const capabilities = dependencies.capabilities;
          if (!capabilities) throw new Error("No grant store is available.");
          // The agent signs as the person; that is decided per chat, never for every chat.
          if (capability === "ssh-agent" && target.scope !== "chat")
            throw new Error("Signing in with SSH keys is allowed per chat only.");
          if (add) await capabilities.add(target, capability);
          else await capabilities.remove(target, capability);
        },
        catch: (cause) =>
          new DesktopError({
            reason: "failed",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });

    return Sandbox.of({
      availability,
      setUp: availability,
      run,
      permissions: (target) =>
        Effect.sync(() => ({
          network: grants?.list(target) ?? [],
          paths: dependencies.paths?.list(target) ?? [],
          capabilities: (dependencies.capabilities?.list(target) ?? []).filter(
            (entry): entry is Capability => CAPABILITIES.has(entry),
          ),
        })),
      forgetChat: (chat) =>
        Effect.promise(async () => {
          for (const id of (await grants?.forgetChat(chat)) ?? []) proxy.regrant(id);
          await dependencies.paths?.forgetChat(chat);
          await dependencies.capabilities?.forgetChat(chat);
        }),
      approveCapability: (target, capability) => changeCapability(target, capability, true),
      revokeCapability: (target, capability) => changeCapability(target, capability, false),
      approveNetwork: (target, grant) => changeNetwork(target, grant, true),
      revokeNetwork: (target, grant) => changeNetwork(target, grant, false),
      keepAnswers: (origin, live) =>
        Effect.sync(() => {
          for (const id of grants?.keepAnswers(origin, live) ?? []) proxy.regrant(id);
          dependencies.paths?.keepAnswers(origin, live);
          dependencies.capabilities?.keepAnswers(origin, live);
        }),
      approvePath: (target, path) =>
        Effect.tryPromise({
          try: async () => {
            const paths = dependencies.paths;
            if (!paths) throw new Error("No path grant store is available.");
            const checked = await checkPathGrant(path, {
              home,
              denied: [...CREDENTIAL_DENIES, ...(grants ? [grants.directory] : [])],
            });
            if (!checked.ok) throw new Error(checked.reason);
            await paths.add(target, checked.path);
            return checked.path;
          },
          catch: (cause) =>
            new DesktopError({
              reason: "failed",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }),
      revokePath: (target, path) =>
        Effect.tryPromise({
          try: async () => dependencies.paths?.remove(target, path),
          catch: (cause) =>
            new DesktopError({
              reason: "failed",
              message: `Could not remove access: ${String(cause)}`,
            }),
        }),
    });
  });
