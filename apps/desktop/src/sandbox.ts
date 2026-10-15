import { execFileSync } from "node:child_process";
import {
  access,
  constants,
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, win32 } from "node:path";
import type { Readable } from "node:stream";
import {
  createEgressProxy,
  childEnvironment as proxyEnvironment,
  type CommandContext,
  type Denial,
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
import {
  DesktopError,
  LIMITS,
  type AgentSetting,
  type SandboxAvailability,
} from "@chat/desktop-rpc";
import {
  loadEgressGrants,
  normalizeEgressGrant,
  type AnswerKey,
  type ChatKey,
  type EgressGrant,
  type EgressGrants,
  type GrantTarget,
} from "./egress-grants.ts";
import { makeCommandRoot, type CommandRoot } from "./command-root.ts";
import {
  checkPathGrant,
  credentialLinks,
  loadPathGrants,
  pathRefusal,
  spellings,
  touchesDenied,
  unaliased,
  within,
  type PathGrants,
  type PathRules,
} from "./path-grants.ts";
import { loadScopedGrants, type ScopedGrants } from "./scoped-grants.ts";
import {
  commandEnvironment,
  jvmEnvironment,
  jvmProxyArguments,
  mavenSettings,
} from "./sandbox-environment.ts";
import {
  AGENT_DESTINATION,
  agentKeyCount,
  answersAsAgent,
  findAgent,
  loadAgentChoice,
  agentExists,
  knownAgents,
  WINDOWS_AGENT,
  type AgentChoice,
  type KnownAgent,
} from "./ssh-agent.ts";

/** What the person is asked to confirm: a socket to use, or going back to the default. */
export type AgentChange =
  | { readonly kind: "use"; readonly socket: string; readonly name: string | null }
  | { readonly kind: "default"; readonly fallback: string | null; readonly name: string | null };
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
 * The toolchain folders commands read. Not ~/.cache on Linux: bubblewrap lets a command connect
 * to a socket in a folder it may only read, and that one holds sockets (IBus's) at any depth.
 * Commands keep their caches in the workspace (XDG_CACHE_HOME), where tools look first.
 */
const toolchainRead = (os: NodeJS.Platform) =>
  os === "linux" ? TOOLCHAIN_READ.filter((path) => path !== inHome(".cache")) : TOOLCHAIN_READ;

/**
 * Credential files inside the readable toolchain folders, or inside a folder
 * the person attached. A denied path outranks every grant in MXC.
 */
export const CREDENTIAL_DENIES = [
  inHome(".cache", "huggingface", "token"),
  inHome(".cache", "gh"),
  inHome(".config", "git", "credentials"),
  // git credential-cache's daemon socket answers whoever opens it.
  inHome(".cache", "git"),
  inHome(".git-credential-cache"),
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
  // Nix's store and profiles, never all of /nix: bubblewrap lets a command connect to a socket
  // in a folder it may only read (measured), and the daemon's socket would build and fetch
  // for it on the host, past the proxy.
  return [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/opt",
    "/nix/store",
    "/nix/var/nix/profiles",
    "/snap",
  ];
};

/**
 * Per-user folders macOS hands to developer tools through confstr, ignoring TMPDIR. Readable
 * only: every app keeps sockets there (an ssh-agent started in a terminal, VS Code's git
 * credential helper, Chrome's open-this-URL socket), and a writable grant lets a command
 * connect to them. Measured: git, xcrun, clang, swiftc and make work with them read-only.
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

const macDeveloperDir = (): string | null => {
  try {
    return execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
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
  /** The user's SSH agent sockets, reached only through the proxy, never opened directly. */
  readonly agentSockets?: readonly string[];
  /** Where credential paths that are links really lead: denied too, as a deny holds a path. */
  readonly credentialTargets?: readonly string[];
  /** Sockets found in readable folders (Linux), which a command could otherwise connect to. */
  readonly readableSockets?: readonly string[];
  readonly userFolders: ReadonlyArray<string>;
}

/** Read the system and toolchains, write the attached folders, never touch credentials. */
export const filesystemPolicy = (input: PolicyInput) => ({
  readwritePaths: [
    ...input.writable,
    // bubblewrap gives each command its own /dev; binding the host's /dev/null over it breaks it.
    ...(input.os === "darwin" ? ["/dev/null"] : []),
  ],
  readonlyPaths: [
    ...systemRead(input.os),
    ...toolchainRead(input.os),
    ...(input.os === "win32" ? windowsToolchainRead(process.env) : []),
    ...input.readable,
    ...input.userFolders,
  ],
  deniedPaths: [
    ...CREDENTIAL_DENIES,
    // A credential linked into a writable folder: the folder a rename could move is denied too.
    ...socketDenies(input.credentialTargets ?? [], input.writable),
    ...(input.readableSockets ?? []),
    ...(input.protectedDirectory ? [input.protectedDirectory] : []),
    ...socketDenies(input.agentSockets ?? [], input.writable),
  ],
});

/**
 * A deny holds a path, not a file: a command that can rename a folder above a denied socket
 * reaches the socket by the new name (measured with Seatbelt). Under a writable folder the deny
 * also covers the topmost folder between it and the socket, which no command can rename.
 */
export const socketDenies = (sockets: readonly string[], writable: readonly string[]) =>
  sockets.flatMap((socket) => {
    const holder = writable
      .filter((folder) => within(folder, socket))
      .toSorted((a, b) => depth(a) - depth(b))[0];
    // Counted as a depth, which no spelling (macOS's /private, case) can change, and cut from
    // the socket's own path.
    const steps = holder ? depth(socket) - depth(holder) : 0;
    // Directly in the writable folder, the socket's own deny is all a rename could touch.
    if (steps < 2) return [socket];
    let folder = socket;
    for (let up = 1; up < steps; up += 1) folder = dirname(folder);
    return [...new Set([socket, folder, unaliased(folder)])];
  });

/** How many names a path has below its root, whatever its spelling. */
const depth = (path: string) =>
  unaliased(normalize(path))
    .split(/[\\/]+/)
    .filter(Boolean).length;

type FilesystemPolicy = ReturnType<typeof filesystemPolicy>;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const present = async (paths: readonly string[]) => {
  const found = await Promise.all(paths.map(exists));
  return paths.filter((_, index) => found[index]);
};

/**
 * Windows refuses a whole policy naming a path that does not exist, and
 * bubblewrap fails to start on a missing one it should mount, or deny inside a
 * read-only mount; Seatbelt skips them, and gets the same grants so every
 * platform runs one policy. Only Seatbelt can keep a missing path denied, so
 * elsewhere a credential created mid-command under a readable folder is not.
 */
const existingOnly = async (
  policy: FilesystemPolicy,
  os: NodeJS.Platform,
): Promise<FilesystemPolicy> => {
  const [readwritePaths, readonlyPaths, deniedPaths] = await Promise.all([
    present(policy.readwritePaths),
    present(policy.readonlyPaths),
    // Seatbelt keeps a missing denied path denied, so a token written while the command runs
    // (into a readable cache folder) does not become readable there.
    os === "darwin" ? policy.deniedPaths : present(policy.deniedPaths),
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
  // bubblewrap gives each command its own network namespace with its own loopback, so a
  // command can always talk to itself and never to the host's services.
  os === "linux"
    ? {
        egress: { default: "deny" },
        ingress: { default: "deny", hostLoopback: "deny" },
        runtimeConfig: { networkProxy: proxyUrl },
      }
    : os === "win32" && local
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
const withSsh = (environment: Record<string, string>, ssh: SshSetup | null, os: NodeJS.Platform) =>
  ssh
    ? {
        ...environment,
        PATH: [ssh.bin, environment.PATH].filter(Boolean).join(os === "win32" ? ";" : ":"),
        // git must use the wrapper even when core.sshCommand names another ssh. Git for Windows
        // runs GIT_SSH_COMMAND through its MSYS shell, which cannot start in the container, and
        // GIT_SSH without one.
        ...(os === "win32"
          ? { GIT_SSH: ssh.wrapper, GIT_SSH_VARIANT: "ssh", ...windowsSigner(environment, ssh) }
          : { GIT_SSH_COMMAND: `"${ssh.wrapper}"` }),
      }
    : environment;

/**
 * Git for Windows finds programs on PATH as .exe only, so commit signing would start the real
 * ssh-keygen outside the agent bridge; named in git's environment config, the wrapper runs.
 */
export const windowsSigner = (environment: Record<string, string>, ssh: SshSetup) => {
  if (!ssh.keygen) return {};
  const index = Number(environment.GIT_CONFIG_COUNT ?? "0");
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "gpg.ssh.program",
    [`GIT_CONFIG_VALUE_${index}`]: ssh.keygen,
  };
};

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
  /** The chat's workspace, where the command starts: the one writable place in app data. */
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
  /** The user's SSH agent, looked up before each command. */
  readonly agent: () => Promise<string | null>;
  /** The agent socket the person chose in Settings. */
  readonly agentChoice?: AgentChoice | null;
  /** Where known agents put their socket; the home directory's by default. */
  readonly knownAgents?: () => readonly KnownAgent[];
  readonly userFolders: () => ReadonlyArray<string>;
  /**
   * Where each command's private folder is made: a place no command may read or write, never
   * the per-user temp folder macOS developer tools need, which every command can write. The
   * sandbox closes it when it closes.
   */
  readonly commandRoot: CommandRoot;
  /** What a path grant may never name; the command roots are added as they are made. */
  readonly pathRules: PathRules;
  /** The app's own data in each spelling, which no built-in readable folder may open either. */
  readonly appData?: readonly string[];
  /** The active Xcode or Command Line Tools (macOS), named so its stub tools stay quiet. */
  readonly developerDir?: string | null;
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
    /** Refuses a folder to attach that would open credentials or the app's own data. */
    checkFolder(path: string): Effect.Effect<void, DesktopError>;
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
    /** The agent socket chosen in Settings, and the one used when none is. */
    agentSetting(): Effect.Effect<AgentSetting>;
    /**
     * Chooses the agent socket, or clears the choice with null; false when the person declined.
     * A socket must answer as an agent, and `confirm` (the app's own dialog) must agree, since
     * the page asking is the server's.
     */
    chooseAgent(
      socket: string | null,
      confirm: (change: AgentChange) => Promise<boolean>,
    ): Effect.Effect<boolean, DesktopError>;
  }
>()("desktop/Sandbox") {
  static readonly layerAt = (directory: string) =>
    Layer.effect(
      Sandbox,
      Effect.flatMap(
        Effect.promise(async () => {
          // macOS's tmpdir is the per-user folder every command can write; /private/tmp is not.
          // Linux uses /tmp whatever TMPDIR says: the root's path must hold no spaces (POSIX
          // launchers split Maven and Gradle arguments) and leave room for a socket name.
          const commandRoot = await makeCommandRoot(
            platform() === "darwin" ? "/private/tmp" : platform() === "linux" ? "/tmp" : tmpdir(),
          );
          // The app's own data: permissions, other chats' workspaces, cookies. Home, its
          // credentials and the app's data in both spellings, since paths arrive real.
          const appData = dirname(directory);
          const realAppData = await realpath(appData).catch(() => appData);
          const realHome = await realpath(home).catch(() => home);
          const pathRules = {
            home: realHome,
            denied: [
              ...CREDENTIAL_DENIES,
              ...(realHome === home
                ? []
                : CREDENTIAL_DENIES.map((path) => join(realHome, relative(home, path)))),
              appData,
              realAppData,
            ],
          };
          return Promise.all([
            commandRoot,
            pathRules,
            [appData, realAppData],
            loadEgressGrants(directory),
            loadPathGrants(directory, {
              ...pathRules,
              denied: [...pathRules.denied, ...commandRoot.all()],
            }),
            loadScopedGrants(directory, "capability-grants.json", (entry) =>
              CAPABILITIES.has(entry),
            ),
            loadAgentChoice(directory),
          ]);
        }),
        ([commandRoot, pathRules, appData, grants, paths, capabilities, agentChoice]) =>
          makeSandbox({
            os: platform(),
            support: getPlatformSupport,
            backends: getAvailableBackends,
            launch: spawn,
            grants,
            paths,
            capabilities,
            agent: () =>
              findAgent({
                os: platform(),
                env: process.env,
                chosen: agentChoice.current(),
                exists: agentExists,
              }),
            agentChoice,
            userFolders: () => (platform() === "darwin" ? macUserFolders() : []),
            developerDir: platform() === "darwin" ? macDeveloperDir() : null,
            commandRoot,
            pathRules,
            appData,
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

/** Revoking the agent in a chat closes the relayed connections it allowed. */
const AGENT_GRANT = "capability:ssh-agent";

const unavailable = (message: string) =>
  new DesktopError({ reason: "sandbox-unavailable", message });
/** A setup step that failed; its cause reads as a sentence for the model. */
const setupFailed = (cause: unknown) =>
  unavailable(
    `Could not start the command: ${cause instanceof Error ? cause.message : String(cause)}`,
  );

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

/**
 * One line per refused tunnel. One a grant would allow is in the form the site reads to offer
 * access, marked when the grant must also opt into private-network addresses; any other refusal
 * (plain HTTP, loopback, a limit, the agent, its own switch) carries its reason instead.
 */
export const denialLine = ({ host, port, reason, lift }: Omit<Denial, "context">) => {
  // The grant store says which grant it is: an IP literal or a private-suffix name is only ever
  // a private-network grant, and some names are no grant at all.
  const kind =
    lift !== "grant" || normalizeEgressGrant(host, port, false)
      ? lift
      : normalizeEgressGrant(host, port, true)
        ? "private-network"
        : null;
  return kind !== null && host !== AGENT_DESTINATION.host
    ? `deny network-outbound ${host}:${port}${kind === "private-network" ? " private-network" : ""}`
    : `refused network-outbound ${host || "?"}:${port}: ${reason}`;
};

/** The paths that open none of `places` by their name or their real path; `own` always stays. */
const notOpening = async (
  paths: readonly string[],
  own: ReadonlySet<string>,
  places: readonly string[],
) => {
  const opens = await Promise.all(
    paths.map((path) =>
      own.has(path)
        ? false
        : realpath(path).then(
            (real) => touchesDenied(path, places) || touchesDenied(real, places),
            () => touchesDenied(path, places),
          ),
    ),
  );
  return paths.filter((_, index) => !opens[index]);
};

/** System folders of live sockets on Linux: never granted, whatever they hold right now. */
const LINUX_SOCKET_HOMES = ["/run", "/var/run", "/proc", "/sys", "/dev", "/tmp/.X11-unix"];

/**
 * Why a path cannot be granted on Linux for the sockets it is or holds, from a full walk;
 * a tree too large to walk is refused too, rather than trusted unseen.
 */
export const socketHolding = async (path: string, budget = 50_000): Promise<string | null> => {
  if (LINUX_SOCKET_HOMES.some((folder) => within(folder, path) || within(path, folder)))
    return "That holds system sockets, which commands could use to act outside their limits.";
  const real = await realpath(path).catch(() => path);
  let level = [real];
  const first = await lstat(real).catch(() => null);
  // A named pipe too: the kernel lets a read-only mount's FIFO be opened for writing.
  if (first?.isSocket() || first?.isFIFO())
    return "That is a socket or pipe, which commands could use to act outside their limits.";
  if (!first?.isDirectory()) return null;
  while (level.length > 0) {
    const next: string[] = [];
    for (const folder of level) {
      // A folder that cannot be listed may still be entered by name: unchecked is not empty.
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => null);
      if (!entries) return `${folder} cannot be checked for sockets, so it cannot be shared.`;
      budget -= entries.length;
      if (budget < 0)
        return "That folder is too large to check for sockets. Name a folder inside it.";
      for (const entry of entries) {
        if (entry.isSocket() || entry.isFIFO())
          return `That folder holds a socket or pipe (${join(folder, entry.name)}), which commands could use to act outside their limits.`;
        if (entry.isDirectory()) next.push(join(folder, entry.name));
      }
    }
    level = next;
  }
  return null;
};

const SOCKET_SCAN_MS = 10_000;

/** The refusal when a chat allowed the agent but none is running; the web client keys on it. */
export const NO_AGENT = "No SSH agent was running on this computer when the command started.";

/**
 * The sockets in `roots`, a few levels down and within a budget of entries. bubblewrap lets a
 * command connect to a socket in a folder it may only read (measured), and readable home
 * folders can hold one (IBus keeps its socket in ~/.cache/ibus).
 */
export const socketsUnder = async (roots: readonly string[], levels = 3, budget = 20_000) => {
  const found: string[] = [];
  let level = [...roots];
  for (let step = 0; step < levels && level.length > 0 && budget > 0; step += 1) {
    const next: string[] = [];
    for (const folder of level) {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      budget -= entries.length;
      for (const entry of entries) {
        if (entry.isSocket()) found.push(join(folder, entry.name));
        else if (entry.isDirectory()) next.push(join(folder, entry.name));
      }
      if (budget <= 0) break;
    }
    level = next;
  }
  return found;
};

export const makeSandbox = (dependencies: SandboxDependencies) =>
  Effect.gen(function* () {
    const { os, grants } = dependencies;
    const denials = new Map<string, string[]>();
    const running = new Set<LaunchedProcess>();
    let closed = false;

    // Commands whose chat allowed the agent, and where the user's agent was found.
    const relayedAgents = new Map<string, string>();
    // Every agent found stays denied: one chosen before, or gone for a moment, would otherwise
    // be open to the next command.
    const seenAgents = new Set<string>();
    // Bumped around every change of choice: a lookup that spans one is done again, so a command
    // never starts relaying the agent just given up.
    let agentEpoch = 0;
    const currentAgent = async (relayFor?: string) => {
      for (;;) {
        const epoch = agentEpoch;
        const found = await dependencies.agent().catch(() => null);
        if (epoch !== agentEpoch) continue;
        if (found) seenAgents.add(found);
        if (found && relayFor !== undefined) relayedAgents.set(relayFor, found);
        return found;
      }
    };
    const agentGranted = (context: CommandContext) =>
      dependencies.capabilities
        ?.applying({
          origin: context.server,
          conversationId: context.chat,
          attempt: context.attempt,
        })
        .includes("ssh-agent") ?? false;
    const proxy: EgressProxy = createEgressProxy({
      decide: (context, host, port) =>
        host === AGENT_DESTINATION.host && port === AGENT_DESTINATION.port
          ? !agentGranted(context)
            ? { allowed: false, reason: "This chat has not allowed signing in with the SSH agent." }
            : relayedAgents.has(context.command)
              ? { allowed: true, grantId: AGENT_GRANT }
              : // Allowed, but none ran when the command started: asking again would not help.
                { allowed: false, reason: NO_AGENT }
          : grants
            ? grants.decide(context, host, port)
            : { allowed: false, reason: "No grants" },
      local: (context, host, port, proven) => {
        if (host !== AGENT_DESTINATION.host || port !== AGENT_DESTINATION.port) return undefined;
        const agent = relayedAgents.get(context.command);
        // A command's own port (Linux) answers anyone local; the agent wants its token too.
        return agent && proven ? () => connect(agent) : null;
      },
      onDenial: ({ context, ...denial }) => {
        const lines = denials.get(context.command);
        if (lines && lines.length < 20) lines.push(denialLine(denial));
      },
    });
    yield* Effect.promise(() => proxy.listen());

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closed = true;
        for (const process of running) process.kill();
        await proxy.close();
        await dependencies.commandRoot.close();
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

    // Roots made since startup count too: a folder attached earlier may hold one now.
    // A credential path may be a link (a dotfiles manager links ~/.ssh): its target is a
    // credential too, wherever it lies. Resolved at start and again before each command.
    let credentialTargets: readonly string[] = [];
    let credentialWalks = 0;
    let credentialStored = 0;
    const resolveCredentials = async () => {
      const walk = (credentialWalks += 1);
      const found = await credentialLinks(CREDENTIAL_DENIES);
      // A slower, older walk never replaces a newer one's answer.
      if (walk > credentialStored) {
        credentialStored = walk;
        credentialTargets = found;
      }
      return found;
    };
    /** For attach and approval: a credential on a stalled mount refuses rather than hangs. */
    const boundedCredentials = () =>
      Promise.race([
        resolveCredentials(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Checking where credentials lie took too long. Try again.")),
            10_000,
          ).unref(),
        ),
      ]);

    // On Linux a command may connect to a socket it can only read, so a granted path must be
    // no socket and hold none. Judged by a full walk, refused when too large to finish; the
    // answer is reused for a few seconds.
    const socketRefusals = new Map<string, { at: number; refusal: Promise<string | null> }>();
    const linuxSocketRefusal = (path: string): Promise<string | null> => {
      if (os !== "linux") return Promise.resolve(null);
      const now = Date.now();
      const known = socketRefusals.get(path);
      if (known && now - known.at <= SOCKET_SCAN_MS) return known.refusal;
      const refusal = socketHolding(path);
      socketRefusals.set(path, { at: now, refusal });
      return refusal;
    };

    // Linux only (Seatbelt refuses a connect in a read-only folder); looked at every few seconds.
    let socketScan: { at: number; found: Promise<string[]> } | null = null;
    const readableSockets = () => {
      if (os !== "linux") return Promise.resolve([]);
      const now = Date.now();
      if (!socketScan || now - socketScan.at > SOCKET_SCAN_MS)
        socketScan = { at: now, found: socketsUnder(toolchainRead(os)).catch(() => []) };
      return socketScan.found;
    };
    // Not awaited: a credential link onto a stalled mount must not keep the app from opening.
    // Attach, approval and each command walk again, bounded, before relying on it.
    void resolveCredentials().catch(() => undefined);

    const pathRules = (credentials: readonly string[] = credentialTargets): PathRules => ({
      ...dependencies.pathRules,
      denied: [...dependencies.pathRules.denied, ...credentials, ...dependencies.commandRoot.all()],
    });

    // Commands from their first step until their launch has settled: an agent chosen while one
    // runs would be open to it, as its policy was built before the choice.
    let active = 0;
    // Whether a choice of agent is being made, from the request to its end.
    let choosing = false;
    const run = (input: SandboxRun): Effect.Effect<SandboxResult, DesktopError> =>
      Effect.acquireUseRelease(
        Effect.sync(() => (active += 1)),
        () => runCommand(input),
        () => Effect.sync(() => (active -= 1)),
      );

    const known = () => dependencies.knownAgents?.() ?? knownAgents(os, home);
    /** The known agents running here, by their real paths. Looks only at the fixed list. */
    const foundAgents = async () => {
      const found: KnownAgent[] = [];
      for (const agent of known()) {
        const real = await realpath(agent.socket).catch(() => null);
        if (real === null || found.some((entry) => entry.socket === real)) continue;
        if (
          await lstat(real).then(
            (info) => info.isSocket(),
            () => false,
          )
        )
          found.push({ name: agent.name, socket: real });
      }
      return found;
    };
    /** A known agent's name for a socket, also one that is not running now. */
    const agentName = async (socket: string, found: readonly KnownAgent[]) => {
      const real = await realpath(socket).catch(() => socket);
      return (
        [...found, ...known()].find((agent) => agent.socket === real || agent.socket === socket)
          ?.name ?? null
      );
    };
    const choose = async (
      choice: AgentChoice,
      socket: string | null,
      confirm: (change: AgentChange) => Promise<boolean>,
    ) => {
      // Commands relaying any agent but the one now in effect stop at once, rather than when they
      // end, also on a first choice, when theirs was SSH_AUTH_SOCK's.
      const settle = async (next: string | null) => {
        agentEpoch += 1;
        await choice.set(next);
        agentEpoch += 1;
        const now = await dependencies.agent().catch(() => null);
        for (const [command, relayed] of relayedAgents)
          if (relayed !== now) relayedAgents.delete(command);
        proxy.regrant(AGENT_GRANT);
      };
      if (socket === null) {
        if (choice.current() === null) return false;
        const fallback = await findAgent({
          os,
          env: process.env,
          chosen: null,
          exists: agentExists,
        });
        const name = fallback && (await agentName(fallback, await foundAgents()));
        if (!(await confirm({ kind: "default", fallback, name }))) return false;
        await settle(null);
        return true;
      }
      if (os === "win32") throw new Error("Windows commands use Windows’ own agent.");
      if (!isAbsolute(socket)) throw new Error("Name the agent’s socket by its full path.");
      // No command may be running: one started earlier has a policy without the socket, and
      // could replace it before it is used. Asked first, so the answer says nothing of the path.
      if (active > 0) throw new Error("Wait for the commands running on this computer to finish.");
      // Kept by its real path: a link (one a command made) could be pointed elsewhere later.
      const real = await realpath(socket).catch(() => null);
      const valid =
        real !== null &&
        Buffer.byteLength(real) <= (os === "darwin" ? 103 : 107) &&
        (await lstat(real).then(
          (info) => info.isSocket(),
          () => false,
        )) &&
        (await answersAsAgent(real));
      // Again, for a command started during the check, and before the verdict, so that answer
      // too is the same for any path.
      if (active > 0) throw new Error("Wait for the commands running on this computer to finish.");
      // One answer for every refusal: the page must not learn which paths exist. A socket that
      // accepts and never answers is refused only after the agent check's two seconds, which the
      // page could time (accepted).
      if (!valid || real === null) throw new Error(`${socket} isn’t a running SSH agent’s socket.`);
      // Denied from now on, chosen or not.
      seenAgents.add(real);
      const name = await agentName(real, await foundAgents());
      if (!(await confirm({ kind: "use", socket: real, name }))) return false;
      await settle(real);
      return true;
    };

    const runCommand = (input: SandboxRun): Effect.Effect<SandboxResult, DesktopError> =>
      Effect.gen(function* () {
        const available = yield* availability();
        if (available.kind !== "ready") {
          return yield* Effect.fail(
            unavailable(available.kind === "unsupported" ? available.reason : "Unavailable."),
          );
        }
        // The command's deadline covers everything from here, a slow filesystem included.
        const started = Date.now();
        // Links made since the last command count before anything is judged by these rules.
        const [linkedCredentials, workspace] = yield* Effect.tryPromise({
          try: () =>
            Promise.all([resolveCredentials(), realpath(input.cwd).catch(() => input.cwd)]),
          catch: (cause) =>
            new DesktopError({
              reason: "failed",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(Math.max(0, input.timeoutMs)),
            orElse: () => Effect.fail(expired()),
          }),
        );
        // A writable folder holding or inside the app's data or a command root would open other
        // chats' workspaces and other commands' tokens. The chat's own workspace (where the
        // command starts) is the one place inside them a command may write.
        const exposing = input.allowWrite.find(
          (folder) =>
            !within(input.cwd, folder) &&
            !within(workspace, folder) &&
            touchesDenied(folder, pathRules(linkedCredentials).denied),
        );
        if (exposing) {
          return yield* new DesktopError({
            reason: "failed",
            message: `${exposing} holds credentials or the app’s own data. Detach it to run commands.`,
          });
        }
        const context = {
          server: input.context.origin,
          chat: input.context.conversationId,
          attempt: input.context.attempt,
          command: input.callId,
        };
        // Every resource is released as soon as it is acquired, so a Stop or a failure during
        // setup leaves no live token, listener or credential-bearing folder behind.
        const finished = yield* Effect.scoped(
          Effect.gen(function* () {
            // bubblewrap refuses a proxy URL carrying credentials (bwrap's arguments are readable
            // by every local user), and reaches only that one endpoint: there the port is the token.
            const { token, proxyUrl } = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: async () => {
                  const issued =
                    os === "linux" ? await proxy.issuePort(context) : proxy.issue(context);
                  denials.set(input.callId, []);
                  return issued;
                },
                catch: setupFailed,
              }),
              (issued) =>
                Effect.sync(() => {
                  // Ends every tunnel the command opened, and its leftover children's.
                  proxy.revoke(issued.token);
                  denials.delete(input.callId);
                  relayedAgents.delete(input.callId);
                }),
            );
            // Holds the Maven settings (token included) and the ssh setup. Its root is one no
            // command can read or write (never the shared per-user temp folder macOS grants).
            const commandDirectory = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: async () =>
                  mkdtemp(join(await dependencies.commandRoot.current(), "neema-command-")),
                catch: setupFailed,
              }),
              // A process the kill has not yet reaped may still hold a file (Windows); the root
              // goes when the sandbox closes, so a failure here never replaces the result.
              (directory) =>
                Effect.promise(() =>
                  rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(
                    () => undefined,
                  ),
                ),
            );
            const settingsFile = join(commandDirectory, "settings.xml");
            const gradleArgs = join(commandDirectory, "gradle.args");
            const cache = join(input.cwd, ".cache");
            yield* Effect.tryPromise({
              try: () =>
                Promise.all([
                  writeFile(settingsFile, mavenSettings(proxyUrl, join(cache, "m2")), {
                    mode: 0o600,
                  }),
                  writeFile(gradleArgs, jvmProxyArguments(proxyUrl).join("\n"), { mode: 0o600 }),
                ]),
              catch: setupFailed,
            });
            const granted = new Set(dependencies.capabilities?.applying(input.context) ?? []);
            // The agent is never named to the container: the proxy carries it, and its socket is
            // denied to every command, since it may sit where commands can reach. A Windows pipe
            // is no path to deny, so Windows looks only for a chat that relays one.
            const found =
              os === "win32" && !granted.has("ssh-agent")
                ? null
                : yield* Effect.promise(() =>
                    currentAgent(granted.has("ssh-agent") ? input.callId : undefined),
                  );
            const hostAgent = os === "win32" ? null : found;
            const ssh = yield* Effect.tryPromise({
              try: async () => {
                const binary = await findSsh(
                  process.env.PATH,
                  async (file) =>
                    access(file, os === "win32" ? constants.F_OK : constants.X_OK).then(
                      () => true,
                      () => false,
                    ),
                  os,
                );
                return binary
                  ? writeSshSetup({
                      os,
                      directory: commandDirectory,
                      ssh: binary,
                      node: process.execPath,
                      knownHosts: join(home, ".ssh", "known_hosts"),
                      userConfig: join(home, ".ssh", "config"),
                      // By the grant, not the lookup: with no agent running the bridge still asks,
                      // and the proxy's refusal says none was running.
                      relayAgent: granted.has("ssh-agent"),
                      // The URL of a command's own port carries no token; the bridge reads it here.
                      proxyKey: new URL(proxyUrl).username ? null : token,
                    })
                  : null;
              },
              catch: setupFailed,
              // Interruptible, since it reads the user's files (a stalled mount must not hold up
              // Stop). Abandoned, it cannot bring the folder back: bin is made non-recursively.
            });
            const environment = withSsh(
              commandEnvironment(
                process.env,
                input.cwd,
                {
                  ...proxyEnvironment(proxyUrl),
                  ...jvmEnvironment(cache, settingsFile, gradleArgs, os),
                  // Spares the stubs (git, xcrun) most xcodebuild lookups, each of which warns on
                  // stderr that the read-only per-user cache folder is unavailable.
                  ...(dependencies.developerDir
                    ? { DEVELOPER_DIR: dependencies.developerDir }
                    : {}),
                },
                os,
              ),
              ssh,
              os,
            );
            // A granted path is checked again each run: a command may since have replaced it, or
            // a folder above it, with a link to somewhere the person never approved.
            const readable = yield* Effect.promise(async () => {
              const paths = dependencies.paths?.applying(input.context) ?? [];
              const checked = await Promise.all(
                paths.map(
                  async (path) =>
                    (await checkPathGrant(path, pathRules(linkedCredentials))).ok &&
                    (await linuxSocketRefusal(path)) === null,
                ),
              );
              return paths.filter((_, index) => checked[index] === true);
            });
            // The agent in effect, every one seen before, and SSH_AUTH_SOCK's when another is
            // chosen, which still answers whoever opens it. Each by the path given and by its
            // real one: a deny holds the path opened, and a link leads past the given one.
            const agentSockets = yield* Effect.promise(async () => {
              const given = [
                hostAgent,
                ...(os === "win32" ? [] : seenAgents),
                os === "win32" ? null : process.env.SSH_AUTH_SOCK,
              ].filter((socket): socket is string => !!socket && isAbsolute(socket));
              const real = (
                await Promise.all(given.map((socket) => realpath(socket).catch(() => socket)))
              ).flatMap(spellings);
              // Where a link led stays denied too: retargeted, it would open the old agent.
              if (os !== "win32") for (const socket of real) seenAgents.add(socket);
              return [...new Set([...given, ...real])];
            });
            const socketsReadable = yield* Effect.promise(readableSockets);
            const policy = yield* Effect.tryPromise({
              try: () =>
                existingOnly(
                  filesystemPolicy({
                    os,
                    // The command's own folder: ssh records host keys there.
                    writable: [...input.allowWrite, commandDirectory],
                    readable: [
                      ...readable,
                      // The ssh bridge runs on the app's own executable.
                      ...(ssh ? [appBundle(process.execPath)] : []),
                    ],
                    protectedDirectory: grants?.directory ?? null,
                    agentSockets,
                    credentialTargets: linkedCredentials,
                    readableSockets: socketsReadable,
                    userFolders: dependencies.userFolders(),
                  }),
                  os,
                ),
              catch: setupFailed,
            });
            // A built-in folder (/opt, a toolchain's, macOS's per-user temp) could hold the app's
            // data or the command roots in an unusual setup (a dev profile there), directly or
            // through a link: such a folder is left out. What the person granted is checked apart.
            const appPlaces = [...(dependencies.appData ?? []), ...dependencies.commandRoot.all()];
            const own = new Set([...readable, ...input.allowWrite, commandDirectory]);
            const filesystem = yield* Effect.promise(async () => ({
              ...policy,
              readwritePaths: await notOpening(policy.readwritePaths, own, appPlaces),
              readonlyPaths: await notOpening(policy.readonlyPaths, own, appPlaces),
            }));
            // Setup spends the same budget as the command: the deadline is the caller's.
            const remaining = input.timeoutMs - (Date.now() - started);
            if (remaining <= 0) return yield* Effect.fail(expired());
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
                ? {
                    ui: {
                      disable: false,
                      clipboard: "none" as const,
                      allowInputInjection: false,
                    },
                  }
                : {}),
              network: networkPolicy(os, proxyUrl, granted.has("local-services")),
              timeoutMs: remaining,
            };
            // A native launch may stall, and Stop and the deadline must not wait for it: the
            // wait is interruptible, and a process that lands after either is killed on arrival.
            const launching = Promise.resolve().then(() => dependencies.launch(request));
            // A launch abandoned midway still counts until its process has come and been killed.
            // One that never settles keeps the agent setting refused until the app restarts.
            active += 1;
            void launching.then(
              () => (active -= 1),
              () => (active -= 1),
            );
            const child = yield* Effect.uninterruptibleMask((restore) =>
              restore(
                Effect.tryPromise({
                  try: () => launching,
                  catch: (cause) => unavailable(`Could not start the command: ${String(cause)}`),
                }),
              ).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    launching.then(
                      (late) => late.kill(),
                      () => undefined,
                    );
                  }),
                ),
                Effect.tap((launched) =>
                  Effect.sync(() => running.add(launched)).pipe(
                    // Stop and the deadline land here: the process tree goes with the command.
                    Effect.andThen(
                      Effect.addFinalizer(() =>
                        Effect.sync(() => {
                          running.delete(launched);
                          launched.kill();
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            );
            return yield* Effect.promise(async () => {
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
            });
          }),
        ).pipe(
          Effect.timeoutOrElse({
            // What the checks above left of the command's own deadline.
            duration: Duration.millis(Math.max(0, input.timeoutMs - (Date.now() - started))),
            orElse: () => Effect.fail(expired()),
          }),
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
          if (add && capability === "ssh-agent") {
            const agent = await currentAgent();
            if (!agent)
              throw new Error(
                os === "win32"
                  ? "No SSH agent was found. Start Windows’ OpenSSH Authentication Agent service."
                  : "No SSH agent was found. Start one, or choose it in Settings › This computer.",
              );
            // An empty agent signs nobody in; retrying logins with it only fails. Windows' pipe is
            // left unasked: opening it takes one of the agent's instances.
            if (os !== "win32" && (await agentKeyCount(agent)) === 0)
              throw new Error(
                "The SSH agent holds no keys, so nothing can sign in with it. Ask the person to add their key with ssh-add, then request it again.",
              );
          }
          // bubblewrap gives every command a loopback of its own and cannot open the host's.
          if (add && capability === "local-services" && os === "linux")
            throw new Error(
              "On Linux commands reach their own local services already. This computer’s can’t be opened to them.",
            );
          if (add) await capabilities.add(target, capability);
          else await capabilities.remove(target, capability);
          // Closes relayed agent connections a removed grant no longer covers.
          if (capability === "ssh-agent") proxy.regrant(AGENT_GRANT);
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
      checkFolder: (path) =>
        Effect.promise(async () => {
          // Unchecked credentials refuse the folder: an old list could miss a fresh link.
          const credentials = await boundedCredentials().catch((cause: unknown) =>
            cause instanceof Error ? cause.message : String(cause),
          );
          if (typeof credentials === "string") return credentials;
          const rules = pathRules(credentials);
          // A link is judged by where it leads as well as by its own name.
          const real = await realpath(path).catch(() => path);
          return pathRefusal(path, rules) ?? pathRefusal(real, rules);
        }).pipe(
          Effect.flatMap((refusal) =>
            refusal
              ? Effect.fail(new DesktopError({ reason: "failed", message: refusal }))
              : Effect.void,
          ),
        ),
      approvePath: (target, path) =>
        Effect.tryPromise({
          try: async () => {
            const paths = dependencies.paths;
            if (!paths) throw new Error("No path grant store is available.");
            const checked = await checkPathGrant(path, pathRules(await boundedCredentials()));
            if (!checked.ok) throw new Error(checked.reason);
            const sockets = await Promise.race([
              linuxSocketRefusal(checked.path),
              new Promise<string>((resolve) =>
                setTimeout(
                  () => resolve("Checking that folder for sockets took too long. Try again."),
                  10_000,
                ).unref(),
              ),
            ]);
            if (sockets) throw new Error(sockets);
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
      agentSetting: () =>
        Effect.promise(async () => {
          const chosen = dependencies.agentChoice?.current() ?? null;
          const found = await foundAgents();
          const socket =
            chosen ??
            (await findAgent({ os, env: process.env, chosen: null, exists: agentExists }));
          return {
            choosable: os !== "win32",
            current:
              socket === null
                ? null
                : {
                    socket,
                    name: await agentName(socket, found),
                    source:
                      chosen !== null
                        ? "chosen"
                        : socket === WINDOWS_AGENT
                          ? "windows"
                          : "environment",
                    running: chosen === null || (await agentExists(chosen)),
                    keys:
                      os === "win32" || (chosen !== null && !(await agentExists(chosen)))
                        ? null
                        : await agentKeyCount(socket),
                  },
            found,
          } satisfies AgentSetting;
        }),
      chooseAgent: (socket, confirm) =>
        Effect.tryPromise({
          try: async (): Promise<boolean> => {
            const choice = dependencies.agentChoice;
            if (!choice) throw new Error("No settings store is available.");
            // One choice at a time, claimed before anything is awaited: the page asking is the
            // server's, and may ask again and again.
            if (choosing) throw new Error("Answer the open question first.");
            choosing = true;
            try {
              return await choose(choice, socket, confirm);
            } finally {
              choosing = false;
            }
          },
          catch: (cause) =>
            new DesktopError({
              reason: "failed",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }),
    });
  });
