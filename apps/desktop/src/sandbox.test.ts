import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCommandRoot } from "./command-root.ts";
import { loadEgressGrants } from "./egress-grants.ts";
import { credentialLinks, loadPathGrants } from "./path-grants.ts";
import { findAgent, loadAgentChoice, pathExists } from "./ssh-agent.ts";
import { loadScopedGrants } from "./scoped-grants.ts";
import { commandEnvironment, jvmEnvironment } from "./sandbox-environment.ts";
import {
  CREDENTIAL_DENIES,
  denialLine,
  socketDenies,
  socketsUnder,
  socketHolding,
  NO_AGENT,
  windowsSigner,
  enumerableAncestors,
  filesystemPolicy,
  makeSandbox,
  networkPolicy,
  type AgentChange,
  type LaunchedProcess,
  type SandboxDependencies,
  type SandboxRun,
} from "./sandbox.ts";

const home = homedir();
const roots: string[] = [];
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-sandbox-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("filesystemPolicy", () => {
  const policy = filesystemPolicy({
    os: "darwin",
    writable: ["/work/project", "/profile/workspaces/chat"],
    readable: ["/opt/shared/specs"],
    protectedDirectory: "/profile/network-grants",
    userFolders: ["/var/folders/xy/T"],
  });

  it("writes only the attached folders and the workspace, and reads the user's temp folder", () => {
    expect(policy.readwritePaths).toEqual([
      "/work/project",
      "/profile/workspaces/chat",
      "/dev/null",
    ]);
    // Readable only: other apps' sockets there must not be reachable.
    expect(policy.readonlyPaths).toContain("/var/folders/xy/T");
  });

  it("reads the paths the person granted", () => {
    expect(policy.readonlyPaths).toContain("/opt/shared/specs");
  });

  it("reads toolchains under home but never home itself", () => {
    expect(policy.readonlyPaths).toContain(join(home, ".cargo", "registry"));
    expect(policy.readonlyPaths).toContain(join(home, ".gitconfig"));
    expect(policy.readonlyPaths).not.toContain(home);
  });

  it("denies credentials and the permission store whatever is attached", () => {
    for (const path of [
      join(home, ".ssh"),
      join(home, ".aws"),
      join(home, ".git-credentials"),
      join(home, ".config", "git", "credentials"),
      "/profile/network-grants",
    ]) {
      expect(policy.deniedPaths).toContain(path);
    }
  });

  it("denies where a credential link really leads, as well as the link", () => {
    const linked = filesystemPolicy({
      os: "darwin",
      writable: ["/work"],
      readable: [],
      protectedDirectory: null,
      userFolders: [],
      credentialTargets: ["/Users/a/.cache/dotfiles/ssh"],
    });
    expect(linked.deniedPaths).toEqual(
      expect.arrayContaining([join(home, ".ssh"), "/Users/a/.cache/dotfiles/ssh"]),
    );
  });

  it("denies the folder a rename could move when a credential links into a writable one", () => {
    const linked = filesystemPolicy({
      os: "darwin",
      writable: ["/w"],
      readable: [],
      protectedDirectory: null,
      userFolders: [],
      credentialTargets: ["/w/secrets/key"],
    });
    expect(linked.deniedPaths).toEqual(expect.arrayContaining(["/w/secrets/key", "/w/secrets"]));
  });

  it("leaves /dev/null to the sandbox on Linux, which gives each command its own /dev", () => {
    const linux = filesystemPolicy({
      os: "linux",
      writable: ["/work"],
      readable: [],
      protectedDirectory: null,
      userFolders: [],
    });
    expect(linux.readwritePaths).toEqual(["/work"]);
  });

  it("reads Nix's store and profiles on Linux, never its daemon's socket", () => {
    const linux = filesystemPolicy({
      os: "linux",
      writable: ["/work"],
      readable: [],
      protectedDirectory: null,
      userFolders: [],
    });
    expect(linux.readonlyPaths).toEqual(
      expect.arrayContaining(["/nix/store", "/nix/var/nix/profiles"]),
    );
    expect(linux.readonlyPaths).not.toContain("/nix");
  });

  it("reads ~/.cache on macOS but not on Linux, where a socket there could be connected to", () => {
    const of = (os: NodeJS.Platform) =>
      filesystemPolicy({
        os,
        writable: [],
        readable: [],
        protectedDirectory: null,
        userFolders: [],
      }).readonlyPaths;
    expect(of("darwin")).toContain(join(home, ".cache"));
    expect(of("linux")).not.toContain(join(home, ".cache"));
  });

  it("leaves /dev/null to the system on Windows", () => {
    const windows = filesystemPolicy({
      os: "win32",
      writable: ["C:\\work"],
      readable: [],
      protectedDirectory: null,
      userFolders: [],
    });
    expect(windows.readwritePaths).toEqual(["C:\\work"]);
  });

  it("reads Windows toolchains under AppData only on Windows", () => {
    const npm = join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm");
    const windows = filesystemPolicy({
      os: "win32",
      writable: [],
      readable: [],
      protectedDirectory: null,
      userFolders: [],
    });
    expect(windows.readonlyPaths).toContain(npm);
    expect(windows.readonlyPaths).toContain(join(home, "scoop"));
    expect(policy.readonlyPaths).not.toContain(npm);
  });
});

describe("networkPolicy", () => {
  const proxy = "http://cmd:t@127.0.0.1:9";

  it("sends everything through the proxy and keeps loopback shut without the grant", () => {
    expect(networkPolicy("darwin", proxy, false)).toEqual({
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
      runtimeConfig: { networkProxy: proxy },
    });
  });

  it("opens loopback for local services and keeps the proxy", () => {
    expect(networkPolicy("darwin", proxy, true)).toMatchObject({
      ingress: { default: "allow", hostLoopback: "allow" },
      runtimeConfig: { networkProxy: proxy },
    });
  });

  it("keeps ingress shut on Linux, where each command has its own loopback", () => {
    for (const local of [false, true])
      expect(networkPolicy("linux", proxy, local)).toEqual({
        egress: { default: "deny" },
        ingress: { default: "deny", hostLoopback: "deny" },
        runtimeConfig: { networkProxy: proxy },
      });
  });

  it("on Windows leaves proxy mode for local services, which allows no other loopback", () => {
    expect(networkPolicy("win32", proxy, false).runtimeConfig).toEqual({ networkProxy: proxy });
    expect(networkPolicy("win32", proxy, true)).toEqual({
      egress: { default: "deny" },
      ingress: { default: "allow", hostLoopback: "allow" },
    });
  });
});

describe("enumerableAncestors", () => {
  it("lists every folder above, once, without the allowed paths themselves", () => {
    expect(
      enumerableAncestors([
        "C:\\Users\\me\\AppData\\Roaming\\npm",
        "C:\\Users\\me\\AppData\\Local\\pnpm",
        "C:\\Windows",
        "D:\\src\\app",
      ]).toSorted(),
    ).toEqual(
      [
        "C:\\",
        "C:\\Users",
        "C:\\Users\\me",
        "C:\\Users\\me\\AppData",
        "C:\\Users\\me\\AppData\\Local",
        "C:\\Users\\me\\AppData\\Roaming",
        "D:\\",
        "D:\\src",
      ].toSorted(),
    );
  });

  it("leaves out a folder that is itself allowed", () => {
    expect(enumerableAncestors(["C:\\work", "C:\\work\\app"])).toEqual(["C:\\"]);
  });
});

describe("commandEnvironment", () => {
  const proxy = { HTTPS_PROXY: "http://cmd:t@127.0.0.1:9" };

  it("keeps identity and locale, drops the rest of the desktop's environment", () => {
    const env = commandEnvironment(
      { PATH: "/usr/bin", HOME: "/home/u", LANG: "C", NODE_OPTIONS: "--require x", SECRET: "s" },
      "/w",
      proxy,
      "linux",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("C");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.SECRET).toBeUndefined();
  });

  it("puts temporary files and caches in the workspace and adds the proxy", () => {
    const env = commandEnvironment({}, "/w", proxy, "linux");
    expect(env).toMatchObject({
      TMPDIR: "/w",
      TEMP: "/w",
      XDG_CACHE_HOME: "/w/.cache",
      HTTPS_PROXY: proxy.HTTPS_PROXY,
    });
  });

  it("names the workspace as TMPDIR on Windows, which MXC leaves alone", () => {
    expect(commandEnvironment({}, "C:\\w", proxy, "win32").TMPDIR).toBe("C:\\w");
  });

  it("keeps one PATH on Windows, whatever the parent spelled it", () => {
    const env = commandEnvironment({ Path: "C:\\Windows" }, "C:\\w", proxy, "win32");
    expect(env.PATH).toBe("C:\\Windows");
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
  });

  it("gives Git for Windows TLS that skips direct CRL fetches and no shell credential helper", () => {
    const windows = commandEnvironment({}, "C:\\w", proxy, "win32");
    expect(windows).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.sslBackend",
      GIT_CONFIG_VALUE_0: "openssl",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    });
    expect(commandEnvironment({}, "/w", proxy, "darwin").GIT_CONFIG_COUNT).toBeUndefined();
  });
});

/** A process that does what the test tells it to, at the moment it says. */
const fakeProcess = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const { promise: exited, resolve: exit } = Promise.withResolvers<{
    exitCode: number;
    timedOut: boolean;
  }>();
  let killed = 0;
  const process: LaunchedProcess = {
    standardOutput: stdout,
    standardError: stderr,
    wait: () => exited,
    kill: () => {
      killed += 1;
      stdout.end();
      stderr.end();
      exit({ exitCode: 137, timedOut: false });
    },
  };
  const finish = (exitCode: number) => {
    stdout.end();
    stderr.end();
    exit({ exitCode, timedOut: false });
  };
  return { process, stdout, stderr, finish, killed: () => killed };
};

/** Resolves with the request once the sandbox launches, so tests wait on the launch itself. */
const launcher = (process: LaunchedProcess) => {
  const { promise: launched, resolve } = Promise.withResolvers<ContainerRequest>();
  const launch = async (request: ContainerRequest) => {
    resolve(request);
    return process;
  };
  return { launch, launched };
};

const run = (overrides: Partial<SandboxRun> = {}): SandboxRun => ({
  callId: "call-1",
  command: "echo hi",
  context: { origin: "https://chat.example", conversationId: "chat-a", attempt: "attempt-1" },
  cwd: "/w",
  allowWrite: ["/w"],
  timeoutMs: 60_000,
  ...overrides,
});

/** What MXC reports on a Windows build that can reach a host proxy and query parent folders. */
const proxyCapable = [
  {
    backend: "processcontainer",
    capabilities: ["ingressHostLoopbackAllow", "filesystemEnumeratePaths"],
    warnings: [],
  },
] satisfies ReturnType<SandboxDependencies["backends"]>;

const harness = async (
  launch: SandboxDependencies["launch"],
  os: NodeJS.Platform = "darwin",
  backends: SandboxDependencies["backends"] = () => proxyCapable,
  extra: Partial<SandboxDependencies> = {},
) => {
  const root = await directory();
  const commandRoot = await makeCommandRoot(await directory());
  // Stands in for the user's agent socket; commands must never be given its path.
  const agent = join(root, "agent.sock");
  await writeFile(agent, "");
  const grants = await loadEgressGrants(root);
  const paths = await loadPathGrants(root, { home, denied: [root] });
  const capabilities = await loadScopedGrants(root, "capability-grants.json", () => true);
  const dependencies: SandboxDependencies = {
    os,
    support: () => ({ isSupported: true, availableMethods: ["seatbelt"] }),
    backends,
    launch,
    grants,
    paths,
    capabilities,
    agent: async () => agent,
    userFolders: () => [],
    commandRoot,
    pathRules: { home, denied: [...CREDENTIAL_DENIES, root] },
    ...extra,
  };
  const scope = await Effect.runPromise(Scope.make());
  const sandbox = await Effect.runPromise(Scope.provide(makeSandbox(dependencies), scope));
  return {
    sandbox,
    grants,
    paths,
    agent,
    commandRoot: await dependencies.commandRoot.current(),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

/** Opens a CONNECT through the command's proxy, as a tool inside the sandbox would. */
const connectThrough = (proxyUrl: string, target: string) =>
  new Promise<string>((resolve, reject) => {
    const url = new URL(proxyUrl);
    const socket = connect(Number(url.port), url.hostname, () => {
      const auth = Buffer.from(
        `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
      ).toString("base64");
      socket.write(`CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      resolve(chunk.toString("latin1").split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.once("error", reject);
  });

describe("run", () => {
  it("launches the command in a shell with the policy, proxy and deadline", async () => {
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close, commandRoot } = await harness(launch);
    const workspace = await directory();
    const result = Effect.runPromise(
      sandbox.run(run({ command: "echo 'it''s'", cwd: workspace, allowWrite: [workspace] })),
    );
    const request = await launched;
    child.stdout.write("hi\n");
    child.finish(0);
    expect(await result).toEqual({ exitCode: 0, output: "hi\n", truncated: false, violations: [] });
    expect(request).toMatchObject({
      command: `/bin/sh -c 'echo '\\''it'\\'''\\''s'\\'''`,
      workingDirectory: workspace,
      network: { egress: { default: "deny" }, ingress: { hostLoopback: "deny" } },
    });
    // Setup spends the same budget, so the container gets at most what is left of it.
    expect(request.timeoutMs).toBeGreaterThan(0);
    expect(request.timeoutMs).toBeLessThanOrEqual(60_000);
    // The workspace, the command's own private folder and /dev/null.
    const [writable, own, devNull, ...rest] = request.filesystem?.readwritePaths ?? [];
    expect([writable, devNull, rest]).toEqual([workspace, "/dev/null", []]);
    expect(own).toMatch(/neema-command-/);
    // Made in the command root, which no command can reach, never in the shared temp folder.
    expect(own?.startsWith(`${commandRoot}/`)).toBe(true);
    const proxyUrl = request.network?.runtimeConfig?.networkProxy ?? "";
    expect(proxyUrl).toMatch(/^http:\/\/cmd:[^@]+@127\.0\.0\.1:\d+$/);
    expect(request.environment?.HTTPS_PROXY).toBe(proxyUrl);
    await close();
  });

  it("lets Windows commands load user32 but keeps the clipboard and input closed", async () => {
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch, "win32");
    const result = Effect.runPromise(sandbox.run(run()));
    const request = await launched;
    child.finish(0);
    await result;
    expect(request.ui).toEqual({ disable: false, clipboard: "none", allowInputInjection: false });
    await close();
  });

  it("names only paths that exist on Windows, which refuses a policy naming one that does not", async () => {
    const workspace = await directory();
    const child = fakeProcess();
    const { promise: missing, resolve } = Promise.withResolvers<string[]>();
    const { promise: writable, resolve: resolveWritable } = Promise.withResolvers<string[]>();
    const { sandbox, close } = await harness(async (request) => {
      // Checked at launch: the command's own folder is gone once it ends.
      const {
        readwritePaths = [],
        readonlyPaths = [],
        deniedPaths = [],
      } = request.filesystem ?? {};
      resolve([...readwritePaths, ...readonlyPaths, ...deniedPaths].filter((p) => !existsSync(p)));
      resolveWritable(readwritePaths);
      return child.process;
    }, "win32");
    const result = Effect.runPromise(
      sandbox.run(run({ cwd: workspace, allowWrite: [workspace, "/nowhere/attached"] })),
    );
    expect(await missing).toEqual([]);
    expect(await writable).toContain(workspace);
    child.finish(0);
    await result;
    await close();
  });

  for (const os of ["darwin", "linux"] as const)
    it(`grants only paths that exist, keeping missing denials where it can (${os})`, async () => {
      const workspace = await directory();
      const child = fakeProcess();
      const { promise: sent, resolve } = Promise.withResolvers<ContainerRequest>();
      const { sandbox, close } = await harness(async (request) => {
        resolve(request);
        return child.process;
      }, os);
      const result = Effect.runPromise(
        sandbox.run(run({ cwd: workspace, allowWrite: [workspace, "/nowhere/attached"] })),
      );
      const {
        readwritePaths = [],
        readonlyPaths = [],
        deniedPaths = [],
      } = (await sent).filesystem ?? {};
      // bubblewrap fails to start on a missing path it should mount.
      expect([...readwritePaths, ...readonlyPaths].filter((p) => !existsSync(p))).toEqual([]);
      // Seatbelt keeps a token written mid-command into a readable cache denied. bubblewrap
      // cannot deny a missing path inside a read-only mount, and fails to start if asked to.
      const token = join(home, ".cache", "huggingface", "token");
      if (!existsSync(token))
        if (os === "darwin") expect(deniedPaths).toContain(token);
        else expect(deniedPaths.filter((p) => !existsSync(p))).toEqual([]);
      child.finish(0);
      await result;
      await close();
    });

  it("is unavailable on a Windows build missing either capability", async () => {
    // Without loopback no command reaches the proxy; without enumeration Node and npm cannot start.
    for (const capabilities of [
      ["filesystemEnumeratePaths"],
      ["ingressHostLoopbackAllow"],
    ] as const) {
      const { sandbox, close } = await harness(
        async () => {
          throw new Error("must not launch");
        },
        "win32",
        () => [{ backend: "processcontainer", capabilities: [...capabilities], warnings: [] }],
      );
      expect(await Effect.runPromise(sandbox.availability())).toEqual({
        kind: "unsupported",
        reason: "Commands need a newer Windows build. Install the latest Windows updates.",
      });
      const exit = await Effect.runPromiseExit(sandbox.run(run()));
      expect(JSON.stringify(exit)).toContain("newer Windows build");
      await close();
    }
  });

  it("lets Windows commands query the folders above what they may use", async () => {
    const workspace = await directory();
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch, "win32");
    const result = Effect.runPromise(sandbox.run(run({ cwd: workspace, allowWrite: [workspace] })));
    const request = await launched;
    child.finish(0);
    await result;
    const containment = request.containment;
    const enumerate =
      containment?.type === "processcontainer"
        ? containment.config?.filesystem?.enumeratePaths
        : [];
    expect(enumerate).toContain(dirname(workspace));
    expect(enumerate).not.toContain(workspace);
    await close();
  });

  it("is ready on a Windows build that reports both capabilities", async () => {
    const { sandbox, close } = await harness(async () => {
      throw new Error("not launched");
    }, "win32");
    expect(await Effect.runPromise(sandbox.availability())).toEqual({ kind: "ready" });
    await close();
  });

  it("leaves the UI policy to the backend elsewhere", async () => {
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch);
    const result = Effect.runPromise(sandbox.run(run()));
    const request = await launched;
    child.finish(0);
    await result;
    expect(request.ui).toBeUndefined();
    await close();
  });

  it("gives a Linux command its own proxy port and no credentials to leak", async () => {
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch, "linux");
    const result = Effect.runPromise(sandbox.run(run()));
    const request = await launched;
    const proxyUrl = request.network?.runtimeConfig?.networkProxy ?? "";
    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await connectThrough(proxyUrl, "example.com:443")).toMatch(/^HTTP\/1\.1 403/);
    child.finish(0);
    expect((await result).violations).toEqual(["deny network-outbound example.com:443"]);
    // The port closes with the command.
    expect(await connectThrough(proxyUrl, "example.com:443").catch(() => "refused")).toBe(
      "refused",
    );
    await close();
  });

  it("counts setup against the command's time limit", async () => {
    // The agent lookup stands in for slow setup: each call moves the clock on 40 seconds.
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const launched: ContainerRequest[] = [];
    const { sandbox, close } = await harness(
      async (request) => {
        launched.push(request);
        const child = fakeProcess();
        child.finish(0);
        return child.process;
      },
      "darwin",
      () => proxyCapable,
      {
        agent: async () => {
          now += 40_000;
          return "/tmp/agent.sock";
        },
      },
    );
    const chat = { origin: "https://chat.example", conversationId: "chat-a" };
    await Effect.runPromise(sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"));
    await Effect.runPromise(sandbox.run(run({ timeoutMs: 60_000 })));
    expect(launched[0]?.timeoutMs).toBe(20_000);
    // Setup that outlasts the budget never launches.
    const late = await Effect.runPromiseExit(sandbox.run(run({ timeoutMs: 30_000 })));
    expect(JSON.stringify(late)).toContain("timed-out");
    expect(launched).toHaveLength(1);
    vi.restoreAllMocks();
    await close();
  });

  it("releases the token and private folder of a command stopped during setup", async () => {
    const { promise: lookingUp, resolve: lookupStarted } = Promise.withResolvers<void>();
    let lookups = 0;
    const { sandbox, close, commandRoot, agent } = await harness(
      async () => {
        throw new Error("must not launch");
      },
      "darwin",
      () => proxyCapable,
      {
        // Approving looks the agent up once; the command's own lookup then never answers.
        agent: async () => {
          if (lookups++ === 0) return join(commandRoot, "..");
          lookupStarted();
          return new Promise<never>(() => {});
        },
      },
    );
    void agent;
    const chat = { origin: "https://chat.example", conversationId: "chat-a" };
    await Effect.runPromise(sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"));
    const fiber = Effect.runFork(sandbox.run(run()));
    await lookingUp;
    // By now the token is issued and written into the command's own folder.
    const [folder] = await readdir(commandRoot);
    const settings = await readFile(join(commandRoot, folder ?? "", "settings.xml"), "utf8");
    const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(settings)?.[1];
    const proxyUrl = `http://cmd:${field("password")}@127.0.0.1:${field("port")}`;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(await readdir(commandRoot)).toEqual([]);
    expect(await connectThrough(proxyUrl, "example.com:443")).toMatch(/^HTTP\/1\.1 407/);
    vi.restoreAllMocks();
    await close();
  });

  it("reports a refused tunnel as a violation of that command only", async () => {
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch);
    const result = Effect.runPromise(sandbox.run(run()));
    const proxyUrl = (await launched).network?.runtimeConfig?.networkProxy ?? "";
    expect(await connectThrough(proxyUrl, "example.com:443")).toMatch(/^HTTP\/1\.1 403/);
    expect(await connectThrough(proxyUrl, "example.com:22")).toMatch(/^HTTP\/1\.1 403/);
    child.finish(1);
    expect((await result).violations).toEqual([
      "deny network-outbound example.com:443",
      "deny network-outbound example.com:22",
    ]);
    await close();
  });

  it("revokes the command's token when it ends", async () => {
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch);
    const result = Effect.runPromise(sandbox.run(run()));
    const proxyUrl = (await launched).network?.runtimeConfig?.networkProxy ?? "";
    child.finish(0);
    await result;
    expect(await connectThrough(proxyUrl, "example.com:443")).toMatch(/^HTTP\/1\.1 407/);
    await close();
  });

  it("keeps the first output characters and says it truncated", async () => {
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch);
    const result = Effect.runPromise(sandbox.run(run()));
    await launched;
    child.stdout.write("x".repeat(40_000));
    child.finish(0);
    const finished = await result;
    expect(finished.output).toHaveLength(32_000);
    expect(finished.truncated).toBe(true);
    await close();
  });

  it("kills the process when the run is interrupted", async () => {
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch);
    const fiber = Effect.runFork(sandbox.run(run()));
    await launched;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(child.killed()).toBeGreaterThan(0);
    await close();
  });

  it("stops at once while the launch hangs, and kills a process that lands late", async () => {
    const { promise: launching, resolve: launchStarted } = Promise.withResolvers<void>();
    const { promise: landed, resolve: land } = Promise.withResolvers<LaunchedProcess>();
    const { sandbox, close, commandRoot } = await harness(async () => {
      launchStarted();
      return landed;
    });
    const fiber = Effect.runFork(sandbox.run(run()));
    await launching;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(await readdir(commandRoot)).toEqual([]);
    const late = fakeProcess();
    const { promise: killed, resolve: kill } = Promise.withResolvers<void>();
    land({ ...late.process, kill });
    await killed;
    await close();
  });

  it("refuses to run with a writable folder that holds a command root", async () => {
    const { sandbox, close, commandRoot } = await harness(async () => {
      throw new Error("must not launch");
    });
    const exit = await Effect.runPromiseExit(
      sandbox.run(run({ allowWrite: ["/w", dirname(commandRoot)] })),
    );
    expect(JSON.stringify(exit)).toContain("Detach it to run commands");
    await close();
  });

  it("writes in its own workspace inside the app's data, never in another chat's", async () => {
    const appData = await directory();
    const own = join(appData, "workspaces", "chat-a");
    const other = join(appData, "workspaces", "chat-b");
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch, "darwin", () => proxyCapable, {
      pathRules: { home, denied: [...CREDENTIAL_DENIES, appData] },
    });
    const refused = await Effect.runPromiseExit(
      sandbox.run(run({ cwd: own, allowWrite: [own, other] })),
    );
    expect(JSON.stringify(refused)).toContain("Detach it to run commands");
    const result = Effect.runPromise(sandbox.run(run({ cwd: own, allowWrite: [own] })));
    await launched;
    child.finish(0);
    expect((await result).exitCode).toBe(0);
    await close();
  });

  it("denies the user's agent socket to a chat that never allowed the agent", async () => {
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close, agent } = await harness(launch);
    const result = Effect.runPromise(sandbox.run(run()));
    expect((await launched).filesystem?.deniedPaths).toContain(agent);
    child.finish(0);
    await result;
    await close();
  });

  it("denies the environment's agent socket when another is chosen", async () => {
    const socket = join(await directory(), "env-agent.sock");
    vi.stubEnv("SSH_AUTH_SOCK", socket);
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch, "darwin", () => proxyCapable, {
      agent: async () => join(await directory(), "chosen.sock"),
    });
    const result = Effect.runPromise(sandbox.run(run()));
    expect((await launched).filesystem?.deniedPaths).toContain(socket);
    child.finish(0);
    await result;
    vi.unstubAllEnvs();
    await close();
  });

  it.runIf(process.platform === "darwin")(
    "leaves out a built-in readable folder that holds the app's data",
    async () => {
      const child = fakeProcess();
      const { launch, launched } = launcher(child.process);
      const { sandbox, close } = await harness(launch, "darwin", () => proxyCapable, {
        appData: ["/opt/chat/.data/dev/desktop"],
      });
      const result = Effect.runPromise(sandbox.run(run()));
      const readable = (await launched).filesystem?.readonlyPaths ?? [];
      expect(readable).not.toContain("/opt");
      expect(readable).toContain("/usr");
      child.finish(0);
      await result;
      await close();
    },
  );

  it("leaves out a built-in folder holding the app's data, also through a link", async () => {
    const temp = await directory();
    const elsewhere = await directory();
    const appData = join(elsewhere, "profile");
    const linked = join(await directory(), "cache");
    await symlink(elsewhere, linked);
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch, "darwin", () => proxyCapable, {
      appData: [join(temp, "profile"), appData],
      userFolders: () => [temp, linked],
    });
    const result = Effect.runPromise(sandbox.run(run()));
    const { readwritePaths = [], readonlyPaths = [] } = (await launched).filesystem ?? {};
    for (const path of [temp, linked]) {
      expect(readwritePaths).not.toContain(path);
      expect(readonlyPaths).not.toContain(path);
    }
    child.finish(0);
    await result;
    await close();
  });

  it("denies a linked agent socket where it really is, and its folder", async () => {
    const temp = await realpath(await directory());
    await mkdir(join(temp, "ssh-x"));
    const real = join(temp, "ssh-x", "agent.1");
    await writeFile(real, "");
    const link = join(await directory(), "ssh_auth_sock");
    await symlink(real, link);
    vi.stubEnv("SSH_AUTH_SOCK", link);
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch, "darwin", () => proxyCapable, {
      agent: async () => null,
    });
    // The socket sits in an attached folder, which commands can write.
    const result = Effect.runPromise(sandbox.run(run({ allowWrite: ["/w", temp] })));
    const denied = (await launched).filesystem?.deniedPaths ?? [];
    expect(denied).toEqual(expect.arrayContaining([link, real, dirname(real)]));
    child.finish(0);
    await result;
    vi.unstubAllEnvs();
    await close();
  });

  it("tells a chat that allowed the agent when none was running", async () => {
    let lookups = 0;
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close, agent } = await harness(launch, "darwin", () => proxyCapable, {
      agent: async () => (lookups++ === 0 ? join(tmpdir(), "approved-agent.sock") : null),
    });
    void agent;
    const chat = { origin: "https://chat.example", conversationId: "chat-a" };
    await Effect.runPromise(sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"));
    // The agent has gone since it was allowed.
    const result = Effect.runPromise(sandbox.run(run()));
    const proxyUrl = (await launched).network?.runtimeConfig?.networkProxy ?? "";
    expect(await connectThrough(proxyUrl, "ssh-agent.invalid:1")).toMatch(/^HTTP\/1\.1 403/);
    child.finish(1);
    expect((await result).violations).toEqual([
      `refused network-outbound ssh-agent.invalid:1: ${NO_AGENT}`,
    ]);
    vi.restoreAllMocks();
    await close();
  });

  describe.runIf(process.platform !== "win32")("choosing the agent in Settings", () => {
    // An identities answer holding one key: type 12, count 1, blob "k", comment "c".
    const AGENT_REPLY = Buffer.from([0, 0, 0, 15, 12, 0, 0, 0, 1, 0, 0, 0, 1, 107, 0, 0, 0, 1, 99]);
    const EMPTY_AGENT = Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]);
    const setUp = async (
      launch: SandboxDependencies["launch"] = async () => fakeProcess().process,
      // Stands between a command and its agent lookup, to hold one at a chosen moment.
      lookup = (found: Promise<string | null>) => found,
    ) => {
      const folder = await realpath(await directory());
      const servers: ReturnType<typeof createServer>[] = [];
      const listen = async (
        name: string,
        reply: Buffer,
        answering: Promise<void> = Promise.resolve(),
      ) => {
        const path = join(folder, name);
        const server = createServer((socket) =>
          socket.on("data", () => void answering.then(() => socket.write(reply))),
        );
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(path, resolve));
        return path;
      };
      const agentChoice = await loadAgentChoice(folder);
      // SSH_AUTH_SOCK as the app reads it; none unless a test sets it.
      const env: { SSH_AUTH_SOCK?: string } = {};
      const harnessed = await harness(launch, "darwin", () => proxyCapable, {
        agentChoice,
        // Where 1Password would put its socket; nothing is there until a test listens.
        knownAgents: () => [{ name: "1Password", socket: join(folder, "1password.sock") }],
        // As the app wires it: the chosen socket, else SSH_AUTH_SOCK's.
        agent: () =>
          lookup(
            findAgent({ os: "darwin", env, chosen: agentChoice.current(), exists: pathExists }),
          ),
      });
      const asked: AgentChange[] = [];
      const choose = (socket: string | null, answer = true) =>
        Effect.runPromiseExit(
          harnessed.sandbox.chooseAgent(socket, async (change) => {
            asked.push(change);
            return answer;
          }),
        );
      const done = async () => {
        for (const server of servers) server.close();
        await harnessed.close();
      };
      return { ...harnessed, folder, env, listen, agentChoice, asked, choose, done };
    };

    it("takes only a socket that answers as an agent, once the person confirms", async () => {
      const child = fakeProcess();
      child.finish(0);
      const { launch, launched } = launcher(child.process);
      const { listen, folder, agentChoice, asked, choose, sandbox, done } = await setUp(launch);
      const agent = await listen("agent.sock", AGENT_REPLY);
      const docker = await listen("docker.sock", Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"));
      // Nothing chosen yet: going back to the default asks nothing.
      expect(await choose(null)).toMatchObject({ _tag: "Success", value: false });
      // One refusal for a socket that is no agent, a folder, a missing path and one too long to
      // connect to alike.
      const long = join(folder, "a".repeat(110));
      await mkdir(long);
      for (const path of [docker, folder, join(folder, "missing.sock"), long])
        expect(JSON.stringify(await choose(path))).toContain("isn’t a running SSH agent’s socket");
      expect(asked).toEqual([]);
      expect(await Effect.runPromise(sandbox.chooseAgent(agent, async () => false))).toBe(false);
      expect(agentChoice.current()).toBeNull();
      expect(await choose(agent)).toMatchObject({ _tag: "Success", value: true });
      expect(asked).toEqual([{ kind: "use", socket: agent, name: null }]);
      expect(await Effect.runPromise(sandbox.agentSetting())).toMatchObject({
        current: { socket: agent, name: null, source: "chosen", running: true },
        found: [],
      });
      // Going back to the default is confirmed too: it may hold other keys.
      expect(await choose(null, false)).toMatchObject({ _tag: "Success", value: false });
      expect(agentChoice.current()).toBe(agent);
      expect(await choose(null)).toMatchObject({ _tag: "Success", value: true });
      expect(asked.at(-1)).toMatchObject({ kind: "default" });
      expect(agentChoice.current()).toBeNull();
      await Effect.runPromise(sandbox.run(run()));
      // Refused paths are not denied to commands.
      const denied = (await launched).filesystem?.deniedPaths ?? [];
      expect(denied).not.toContain(folder);
      expect(denied).not.toContain(docker);
      await done();
    });

    it("refuses to let a chat sign in with an agent that holds no keys", async () => {
      const { listen, env, sandbox, done } = await setUp();
      env.SSH_AUTH_SOCK = await listen("empty.sock", EMPTY_AGENT);
      const chat = { origin: "https://chat.example", conversationId: "chat-a" };
      const exit = await Effect.runPromiseExit(
        sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"),
      );
      expect(JSON.stringify(exit)).toContain("The SSH agent holds no keys");
      expect(
        (await Effect.runPromise(sandbox.permissions({ scope: "chat", chat }))).capabilities,
      ).toEqual([]);
      await done();
    });

    it("offers a known agent running here by name, and names a chosen one that has stopped", async () => {
      const { listen, folder, asked, choose, sandbox, done } = await setUp();
      const setting = () => Effect.runPromise(sandbox.agentSetting());
      expect(await setting()).toMatchObject({ found: [] });
      const onePassword = await listen("1password.sock", AGENT_REPLY);
      expect((await setting()).found).toEqual([{ name: "1Password", socket: onePassword }]);
      expect(await choose(onePassword)).toMatchObject({ _tag: "Success", value: true });
      expect(asked).toEqual([{ kind: "use", socket: onePassword, name: "1Password" }]);
      await rm(join(folder, "1password.sock"));
      expect(await setting()).toMatchObject({
        current: { socket: onePassword, name: "1Password", source: "chosen", running: false },
        found: [],
      });
      await done();
    });

    it("keeps the socket by its real path, denied to every later command and relayed", async () => {
      const child = fakeProcess();
      const { launch, launched } = launcher(child.process);
      const { listen, folder, agentChoice, choose, sandbox, done } = await setUp(launch);
      const agent = await listen("agent.sock", AGENT_REPLY);
      const link = join(await directory(), "agent-link.sock");
      await symlink(agent, link);
      expect(await choose(link)).toMatchObject({ _tag: "Success", value: true });
      expect(agentChoice.current()).toBe(join(folder, "agent.sock"));
      const chat = { origin: "https://chat.example", conversationId: "chat-a" };
      await Effect.runPromise(sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"));
      const result = Effect.runPromise(sandbox.run(run()));
      const request = await launched;
      expect(request.filesystem?.deniedPaths).toContain(agent);
      const proxyUrl = request.network?.runtimeConfig?.networkProxy ?? "";
      expect(await connectThrough(proxyUrl, "ssh-agent.invalid:1")).toMatch(/^HTTP\/1\.1 200/);
      // Going back to the default cuts the running command off the agent it gave up.
      expect(await choose(null)).toMatchObject({ _tag: "Success", value: true });
      expect(await connectThrough(proxyUrl, "ssh-agent.invalid:1")).toMatch(/^HTTP\/1\.1 403/);
      child.finish(0);
      await result;
      await done();
    });

    it("asks one question at a time, from the request on", async () => {
      const { promise: answering, resolve: answer } = Promise.withResolvers<void>();
      const { listen, agentChoice, choose, done } = await setUp();
      const slow = await listen("slow.sock", AGENT_REPLY, answering);
      const other = await listen("other.sock", AGENT_REPLY);
      const first = choose(slow);
      // Still checking the first socket, no dialog yet: a second request is refused all the same.
      expect(JSON.stringify(await choose(other))).toContain("Answer the open question first");
      answer();
      expect(await first).toMatchObject({ _tag: "Success", value: true });
      expect(agentChoice.current()).toBe(slow);
      await done();
    });

    it("cuts off SSH_AUTH_SOCK's agent from a command started while the first choice was asked", async () => {
      const child = fakeProcess();
      const { launch, launched } = launcher(child.process);
      const { listen, env, sandbox, done } = await setUp(launch);
      env.SSH_AUTH_SOCK = await listen("env-agent.sock", AGENT_REPLY);
      const chosen = await listen("agent.sock", AGENT_REPLY);
      const chat = { origin: "https://chat.example", conversationId: "chat-a" };
      await Effect.runPromise(sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"));
      let result: Promise<unknown> = Promise.resolve();
      const changed = await Effect.runPromise(
        sandbox.chooseAgent(chosen, async () => {
          // The dialog is open; a command starts, relaying the agent in effect until now.
          result = Effect.runPromise(sandbox.run(run()));
          await launched;
          return true;
        }),
      );
      expect(changed).toBe(true);
      const proxyUrl = (await launched).network?.runtimeConfig?.networkProxy ?? "";
      expect(await connectThrough(proxyUrl, "ssh-agent.invalid:1")).toMatch(/^HTTP\/1\.1 403/);
      child.finish(0);
      await result;
      await done();
    });

    it("never relays the agent given up to a command whose lookup spanned the choice", async () => {
      const child = fakeProcess();
      const { launch, launched } = launcher(child.process);
      let hold = false;
      const { promise: held, resolve: holding } = Promise.withResolvers<void>();
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const { folder, env, sandbox, done } = await setUp(launch, async (found) => {
        if (!hold) return found;
        hold = false;
        const answer = await found;
        holding();
        await gate;
        return answer;
      });
      // Which agent a relayed connection reaches, by the first to be connected to once armed:
      // granting and choosing ask the agents themselves first.
      let armed = false;
      const serve = async (name: string) => {
        const { promise: reached, resolve: reach } = Promise.withResolvers<string>();
        const path = join(folder, name);
        const server = createServer((socket) => {
          if (armed) reach(name);
          socket.on("data", () => socket.write(AGENT_REPLY));
        });
        await new Promise<void>((resolve) => server.listen(path, resolve));
        return { path, server, reached };
      };
      const before = await serve("env-agent.sock");
      const chosen = await serve("agent.sock");
      env.SSH_AUTH_SOCK = before.path;
      const chat = { origin: "https://chat.example", conversationId: "chat-a" };
      await Effect.runPromise(sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"));
      let result: Promise<unknown> = Promise.resolve();
      await Effect.runPromise(
        sandbox.chooseAgent(chosen.path, async () => {
          // A command starts and finds SSH_AUTH_SOCK's agent, but is held before it relays it.
          hold = true;
          result = Effect.runPromise(sandbox.run(run()));
          await held;
          return true;
        }),
      );
      armed = true;
      release();
      const proxyUrl = (await launched).network?.runtimeConfig?.networkProxy ?? "";
      expect(await connectThrough(proxyUrl, "ssh-agent.invalid:1")).toMatch(/^HTTP\/1\.1 200/);
      expect(await Promise.race([before.reached, chosen.reached])).toBe("agent.sock");
      child.finish(0);
      await result;
      before.server.close();
      chosen.server.close();
      await done();
    });

    it("refuses, the same for any path, when a command starts while the socket is checked", async () => {
      const launches: Array<ReturnType<typeof fakeProcess>> = [];
      const started: Array<() => void> = [];
      const { listen, agentChoice, choose, sandbox, done } = await setUp(async () => {
        const child = fakeProcess();
        launches.push(child);
        started.shift()?.();
        return child.process;
      });
      for (const [name, reply] of [
        ["agent.sock", AGENT_REPLY],
        ["docker.sock", Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n")],
      ] as const) {
        const { promise: answering, resolve: answer } = Promise.withResolvers<void>();
        const socket = await listen(name, reply, answering);
        const choice = choose(socket);
        const { promise: launched, resolve: launch } = Promise.withResolvers<void>();
        started.push(launch);
        const running = Effect.runPromise(sandbox.run(run()));
        await launched;
        answer();
        expect(JSON.stringify(await choice)).toContain("Wait for the commands");
        launches.at(-1)?.finish(0);
        await running;
      }
      expect(agentChoice.current()).toBeNull();
      await done();
    });

    it("refuses while a command runs, as its policy was made without the socket", async () => {
      const child = fakeProcess();
      const { launch, launched } = launcher(child.process);
      const { listen, agentChoice, choose, sandbox, done } = await setUp(launch);
      const agent = await listen("agent.sock", AGENT_REPLY);
      const running = Effect.runPromise(sandbox.run(run()));
      await launched;
      expect(JSON.stringify(await choose(agent))).toContain("Wait for the commands");
      // The same answer for any path, so a running command does not tell agents apart.
      expect(JSON.stringify(await choose(join(agent, "missing")))).toContain(
        "Wait for the commands",
      );
      expect(agentChoice.current()).toBeNull();
      child.finish(0);
      await running;
      expect(await choose(agent)).toMatchObject({ _tag: "Success", value: true });
      await done();
    });

    it("counts a stopped command until its late launch is over", async () => {
      const { promise: launching, resolve: launchStarted } = Promise.withResolvers<void>();
      const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
      const { promise: killed, resolve: wasKilled } = Promise.withResolvers<void>();
      const late = fakeProcess();
      const { listen, choose, sandbox, done } = await setUp(async () => {
        launchStarted();
        await gate;
        return {
          ...late.process,
          kill: () => {
            late.process.kill();
            wasKilled();
          },
        };
      });
      const agent = await listen("agent.sock", AGENT_REPLY);
      const fiber = Effect.runFork(sandbox.run(run()));
      await launching;
      await Effect.runPromise(Fiber.interrupt(fiber));
      // Stopped, but its process may still arrive under the old policy.
      expect(JSON.stringify(await choose(agent))).toContain("Wait for the commands");
      openGate();
      await killed;
      expect(await choose(agent)).toMatchObject({ _tag: "Success", value: true });
      await done();
    });

    it("refuses while a command is still being set up, and again once a failed launch is over", async () => {
      const { promise: launching, resolve: launchStarted } = Promise.withResolvers<void>();
      const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
      const { listen, agentChoice, choose, sandbox, done } = await setUp(async () => {
        launchStarted();
        await gate;
        throw new Error("launch failed");
      });
      const agent = await listen("agent.sock", AGENT_REPLY);
      const failing = Effect.runPromiseExit(sandbox.run(run()));
      await launching;
      expect(JSON.stringify(await choose(agent))).toContain("Wait for the commands");
      openGate();
      expect((await failing)._tag).toBe("Failure");
      expect(await choose(agent)).toMatchObject({ _tag: "Success", value: true });
      expect(agentChoice.current()).toBe(agent);
      await done();
    });
  });

  it("keeps denying an agent found earlier when a later lookup finds none", async () => {
    const found = join(tmpdir(), "configured-agent.sock");
    let lookups = 0;
    const launched: ContainerRequest[] = [];
    const { sandbox, close } = await harness(
      async (request) => {
        launched.push(request);
        const child = fakeProcess();
        child.finish(0);
        return child.process;
      },
      "darwin",
      () => proxyCapable,
      {
        agent: async () => {
          if (lookups++ === 0) return found;
          throw new Error("The agent's socket is gone.");
        },
      },
    );
    await Effect.runPromise(sandbox.run(run()));
    await Effect.runPromise(sandbox.run(run()));
    expect(lookups).toBe(2);
    expect(launched[1]?.filesystem?.deniedPaths).toContain(found);
    vi.restoreAllMocks();
    await close();
  });

  it("keeps denying where the agent's link led before it was retargeted", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chat-agent-link-")));
    await writeFile(join(root, "old.sock"), "");
    await writeFile(join(root, "new.sock"), "");
    const link = join(root, "agent-current");
    await symlink(join(root, "old.sock"), link);
    const launched: ContainerRequest[] = [];
    const { sandbox, close } = await harness(
      async (request) => {
        launched.push(request);
        const child = fakeProcess();
        child.finish(0);
        return child.process;
      },
      "darwin",
      () => proxyCapable,
      { agent: async () => link },
    );
    await Effect.runPromise(sandbox.run(run()));
    await rm(link);
    await symlink(join(root, "new.sock"), link);
    await Effect.runPromise(sandbox.run(run()));
    expect(launched[1]?.filesystem?.deniedPaths).toEqual(
      expect.arrayContaining([join(root, "old.sock"), join(root, "new.sock")]),
    );
    await close();
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(process.platform === "darwin")(
    "denies an agent found in the data volume's spelling under the one Seatbelt judges",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "chat-agent-data-")));
      await writeFile(join(root, "agent.sock"), "");
      const launched: ContainerRequest[] = [];
      const { sandbox, close } = await harness(
        async (request) => {
          launched.push(request);
          const child = fakeProcess();
          child.finish(0);
          return child.process;
        },
        "darwin",
        () => proxyCapable,
        { agent: async () => `/System/Volumes/Data${join(root, "agent.sock")}` },
      );
      await Effect.runPromise(sandbox.run(run()));
      expect(launched[0]?.filesystem?.deniedPaths).toContain(join(root, "agent.sock"));
      await close();
      await rm(root, { recursive: true, force: true });
    },
  );

  it("fails with a timeout when MXC reports one", async () => {
    const { sandbox, close } = await harness(async () => ({
      standardOutput: null,
      standardError: null,
      wait: async () => ({ exitCode: 1, timedOut: true }),
      kill: () => {},
    }));
    const exit = await Effect.runPromiseExit(sandbox.run(run({ timeoutMs: 5_000 })));
    expect(exit).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(exit)).toContain("timed-out");
    await close();
  });

  it("refuses to run where MXC has no backend", async () => {
    const grants = await loadEgressGrants(await directory());
    const scope = await Effect.runPromise(Scope.make());
    const sandbox = await Effect.runPromise(
      Scope.provide(
        makeSandbox({
          os: "darwin",
          support: () => ({
            isSupported: false,
            reason: "Needs Apple silicon",
            availableMethods: [],
          }),
          backends: () => {
            throw new Error("only Windows asks");
          },
          launch: async () => {
            throw new Error("must not launch");
          },
          grants,
          paths: null,
          capabilities: null,
          agent: async () => null,
          userFolders: () => [],
          commandRoot: await makeCommandRoot(await directory()),
          pathRules: { home, denied: [] },
        }),
        scope,
      ),
    );
    expect(await Effect.runPromise(sandbox.availability())).toEqual({
      kind: "unsupported",
      reason: "Needs Apple silicon",
    });
    const exit = await Effect.runPromiseExit(sandbox.run(run()));
    expect(JSON.stringify(exit)).toContain("Needs Apple silicon");
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

describe("network approvals", () => {
  const always = { scope: "always" } as const;
  const site = { host: "example.com", port: 443, privateNetwork: false };

  it("lists hosts allowed for every chat and revokes them", async () => {
    const { sandbox, grants, close } = await harness(async () => fakeProcess().process);
    await Effect.runPromise(sandbox.approveNetwork(always, site));
    expect((await Effect.runPromise(sandbox.permissions(always))).network).toEqual([site]);
    expect(
      grants.decide(
        { server: "https://x.example", chat: "other", attempt: "a", command: "c" },
        "example.com",
        443,
      ).allowed,
    ).toBe(true);
    await Effect.runPromise(sandbox.revokeNetwork(always, site));
    expect((await Effect.runPromise(sandbox.permissions(always))).network).toEqual([]);
    await close();
  });

  it("forgets a chat's network and path grants together", async () => {
    const { sandbox, close } = await harness(async () => fakeProcess().process);
    const chat = { origin: "https://chat.example", conversationId: "chat-a" };
    const target = { scope: "chat", chat } as const;
    const shared = await directory();
    await Effect.runPromise(sandbox.approveNetwork(target, site));
    const granted = await Effect.runPromise(sandbox.approvePath(target, shared));
    await Effect.runPromise(sandbox.approveCapability(target, "local-services"));
    expect(await Effect.runPromise(sandbox.permissions(target))).toEqual({
      network: [site],
      paths: [granted],
      capabilities: ["local-services"],
    });
    await Effect.runPromise(sandbox.forgetChat(chat));
    expect(await Effect.runPromise(sandbox.permissions(target))).toEqual({
      network: [],
      paths: [],
      capabilities: [],
    });
    await close();
  });

  it("ends an answer's grants when the page no longer lists it as running", async () => {
    const { sandbox, grants, close } = await harness(async () => fakeProcess().process);
    const answer = {
      origin: "https://chat.example",
      conversationId: "chat-a",
      attempt: "attempt-1",
    };
    const context = {
      server: answer.origin,
      chat: answer.conversationId,
      attempt: answer.attempt,
      command: "c",
    };
    await Effect.runPromise(sandbox.approveNetwork({ scope: "answer", answer }, site));
    expect(grants.decide(context, "example.com", 443).allowed).toBe(true);
    await Effect.runPromise(sandbox.keepAnswers(answer.origin, [answer]));
    expect(grants.decide(context, "example.com", 443).allowed).toBe(true);
    await Effect.runPromise(sandbox.keepAnswers(answer.origin, []));
    expect(grants.decide(context, "example.com", 443).allowed).toBe(false);
    await close();
  });
});

describe("path approvals", () => {
  it("makes an approved path readable to that answer's commands only", async () => {
    const shared = await directory();
    const requests: ContainerRequest[] = [];
    const { sandbox, close } = await harness(async (request) => {
      requests.push(request);
      const child = fakeProcess();
      child.finish(0);
      return child.process;
    });
    const answer = {
      origin: "https://chat.example",
      conversationId: "chat-a",
      attempt: "attempt-1",
    };
    const granted = await Effect.runPromise(
      sandbox.approvePath({ scope: "answer", answer }, shared),
    );
    await Effect.runPromise(sandbox.run(run()));
    await Effect.runPromise(sandbox.run(run({ context: { ...answer, attempt: "attempt-2" } })));
    expect(requests[0]?.filesystem?.readonlyPaths).toContain(granted);
    expect(requests[1]?.filesystem?.readonlyPaths).not.toContain(granted);
    await close();
  });

  it("stops reading a granted path once a link replaces it", async () => {
    const parent = await directory();
    const shared = join(parent, "export");
    await mkdir(shared);
    const requests: ContainerRequest[] = [];
    const { sandbox, close } = await harness(async (request) => {
      requests.push(request);
      const child = fakeProcess();
      child.finish(0);
      return child.process;
    });
    const chat = { origin: "https://chat.example", conversationId: "chat-a" };
    const granted = await Effect.runPromise(sandbox.approvePath({ scope: "chat", chat }, shared));
    await Effect.runPromise(sandbox.run(run()));
    // A command with write access to the parent swaps the folder for a link elsewhere.
    await rm(shared, { recursive: true });
    await symlink(await directory(), shared);
    await Effect.runPromise(sandbox.run(run()));
    expect(requests[0]?.filesystem?.readonlyPaths).toContain(granted);
    expect(requests[1]?.filesystem?.readonlyPaths).not.toContain(granted);
    await close();
  });

  it("refuses the command root, a folder above it and the app's data when approving", async () => {
    const appData = await directory();
    const { sandbox, close, commandRoot } = await harness(
      async () => fakeProcess().process,
      "darwin",
      () => proxyCapable,
      { pathRules: { home, denied: [...CREDENTIAL_DENIES, appData] } },
    );
    for (const path of [commandRoot, dirname(commandRoot), appData]) {
      const exit = await Effect.runPromiseExit(sandbox.approvePath({ scope: "always" }, path));
      expect(JSON.stringify(exit)).toContain("never shared with commands");
    }
    await close();
  });

  it("refuses to attach the command root, a folder above it, the app's data or home", async () => {
    const appData = await directory();
    const { sandbox, close, commandRoot } = await harness(
      async () => fakeProcess().process,
      "darwin",
      () => proxyCapable,
      { pathRules: { home, denied: [...CREDENTIAL_DENIES, appData] } },
    );
    for (const path of [commandRoot, dirname(commandRoot), appData, join(appData, "x"), home]) {
      const exit = await Effect.runPromiseExit(sandbox.checkFolder(path));
      expect(exit).toMatchObject({ _tag: "Failure" });
    }
    // A link elsewhere that leads into the app's data is judged by where it leads.
    const links = await directory();
    await symlink(appData, join(links, "proj"));
    expect(await Effect.runPromiseExit(sandbox.checkFolder(join(links, "proj")))).toMatchObject({
      _tag: "Failure",
    });
    const project = await directory();
    expect(await Effect.runPromiseExit(sandbox.checkFolder(project))).toMatchObject({
      _tag: "Success",
    });
    await close();
  });

  it("refuses on Linux a path holding a socket, which read access would let commands use", async () => {
    const { sandbox, close } = await harness(async () => fakeProcess().process, "linux");
    const root = await realpath(await mkdtemp("/tmp/chat-grant-socket-"));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(root, "s"), resolve));
    const exit = await Effect.runPromiseExit(sandbox.approvePath({ scope: "always" }, root));
    expect(JSON.stringify(exit)).toContain("holds a socket");
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await close();
  });

  it("refuses home and credentials before asking anything of the store", async () => {
    const { sandbox, close } = await harness(async () => fakeProcess().process);
    for (const path of [home, join(home, ".ssh")]) {
      const exit = await Effect.runPromiseExit(sandbox.approvePath({ scope: "always" }, path));
      expect(exit).toMatchObject({ _tag: "Failure" });
    }
    await close();
  });
});

describe("denialLine", () => {
  it("asks for a grant, a private-network one, or gives the reason no grant changes", () => {
    const at = { host: "git.corp.example", port: 22, reason: "r" };
    expect(denialLine({ ...at, lift: "grant" })).toBe("deny network-outbound git.corp.example:22");
    expect(denialLine({ ...at, lift: "private-network" })).toBe(
      "deny network-outbound git.corp.example:22 private-network",
    );
    expect(denialLine({ ...at, lift: null })).toBe(
      "refused network-outbound git.corp.example:22: r",
    );
    // The grant store only takes these as private-network grants.
    for (const host of ["10.0.0.5", "build.corp.internal"])
      expect(denialLine({ host, port: 22, reason: "r", lift: "grant" })).toBe(
        `deny network-outbound ${host}:22 private-network`,
      );
    // A public address takes an ordinary grant, like a name.
    expect(denialLine({ host: "8.8.8.8", port: 22, reason: "r", lift: "grant" })).toBe(
      "deny network-outbound 8.8.8.8:22",
    );
    expect(denialLine({ host: "ssh-agent.invalid", port: 1, reason: "r", lift: "grant" })).toBe(
      "refused network-outbound ssh-agent.invalid:1: r",
    );
  });
});

describe("socketDenies", () => {
  it("also denies the folder a command could rename to reach the socket by another name", () => {
    expect(socketDenies(["/T/ssh-x/agent.1"], ["/T", "/w"])).toEqual([
      "/T/ssh-x/agent.1",
      "/T/ssh-x",
    ]);
    expect(socketDenies(["/T/a/b/agent.1"], ["/T/a", "/T"])).toEqual(["/T/a/b/agent.1", "/T/a"]);
    expect(socketDenies(["/T/agent.1"], ["/T"])).toEqual(["/T/agent.1"]);
    expect(socketDenies(["/private/agent.1"], ["/T"])).toEqual(["/private/agent.1"]);
  });

  it.runIf(process.platform === "darwin")(
    "finds the folder whichever macOS spelling the temp folder and the socket use",
    () => {
      expect(
        socketDenies(["/private/var/folders/x/T/ssh-x/agent.1"], ["/var/folders/x/T/"]),
      ).toEqual([
        "/private/var/folders/x/T/ssh-x/agent.1",
        "/private/var/folders/x/T/ssh-x",
        "/var/folders/x/T/ssh-x",
      ]);
      expect(
        socketDenies(["/var/folders/x/T/ssh-x/agent.1"], ["/private/var/folders/x/T"]),
      ).toEqual(["/var/folders/x/T/ssh-x/agent.1", "/var/folders/x/T/ssh-x"]);
      // macOS ignores case, so a folder attached as Projects holds projects/.agent.
      expect(socketDenies(["/Users/a/projects/.agent/s.sock"], ["/Users/a/Projects"])).toEqual([
        "/Users/a/projects/.agent/s.sock",
        "/Users/a/projects/.agent",
      ]);
    },
  );
});

describe("credentialLinks", () => {
  it("follows every link in a credential tree, nested or through linked folders, once", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chat-credentials-")));
    const ssh = join(root, ".ssh");
    await mkdir(join(ssh, "keys"), { recursive: true });
    await mkdir(join(root, "sync"));
    await writeFile(join(root, "sync", "id_ed25519"), "key");
    await symlink(join(root, "sync", "id_ed25519"), join(ssh, "keys", "id_ed25519"));
    await mkdir(join(root, "dotfiles", "conf"), { recursive: true });
    await writeFile(join(root, "deep-secret"), "x");
    await symlink(join(root, "deep-secret"), join(root, "dotfiles", "conf", "token"));
    await symlink(join(root, "dotfiles", "conf"), join(ssh, "conf"));
    await symlink(ssh, join(ssh, "loop"));
    expect((await credentialLinks([ssh])).toSorted()).toEqual(
      [
        join(root, "deep-secret"),
        join(root, "dotfiles", "conf"),
        join(root, "sync", "id_ed25519"),
      ].toSorted(),
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe("credentialLinks on a folder it cannot list", () => {
  it("fails rather than take it for empty", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chat-locked-")));
    const ssh = join(root, ".ssh");
    await mkdir(join(ssh, "restricted"), { recursive: true });
    await chmod(join(ssh, "restricted"), 0o311);
    await expect(credentialLinks([ssh])).rejects.toThrow(/cannot be checked/);
    await chmod(join(ssh, "restricted"), 0o755);
    await rm(root, { recursive: true, force: true });
  });
});

describe("credentialLinks in a folder it can list but not enter", () => {
  it("fails rather than skip the links it cannot follow", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chat-locked-")));
    const ssh = join(root, ".ssh");
    await mkdir(join(ssh, "locked"), { recursive: true });
    await writeFile(join(root, "key"), "");
    await symlink(join(root, "key"), join(ssh, "locked", "key"));
    await chmod(join(ssh, "locked"), 0o400);
    await expect(credentialLinks([ssh])).rejects.toThrow(/cannot look/);
    await chmod(join(ssh, "locked"), 0o755);
    await rm(root, { recursive: true, force: true });
  });
});

describe("credentialLinks through a folder it cannot enter", () => {
  it("names the link rather than take it for dangling", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chat-chain-")));
    const ssh = join(root, ".ssh");
    await mkdir(ssh);
    await mkdir(join(root, "locked", "inner"), { recursive: true });
    await symlink(join(root, "locked", "inner", "key"), join(ssh, "key"));
    await chmod(join(root, "locked"), 0o000);
    await expect(credentialLinks([ssh])).rejects.toThrow(
      `${join(ssh, "key")} leads where this app cannot look`,
    );
    await chmod(join(root, "locked"), 0o755);
    await rm(root, { recursive: true, force: true });
  });
});

describe.runIf(process.platform === "darwin")("credentialLinks into the data volume", () => {
  it("denies the target under both of its spellings", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chat-data-")));
    const ssh = join(root, ".ssh");
    await mkdir(ssh);
    await writeFile(join(root, "key"), "");
    await symlink(`/System/Volumes/Data${join(root, "key")}`, join(ssh, "key"));
    expect((await credentialLinks([ssh])).toSorted()).toEqual(
      [join(root, "key"), `/System/Volumes/Data${join(root, "key")}`].toSorted(),
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe("credentialLinks within its budget", () => {
  it("finds a link beside a large folder before the folder can use the budget up", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chat-kube-")));
    const kube = join(root, ".kube");
    for (let index = 0; index < 50; index += 1)
      await mkdir(join(kube, "cache", `d${index}`), { recursive: true });
    await writeFile(join(root, "config-target"), "x");
    await symlink(join(root, "config-target"), join(kube, "config"));
    expect(await credentialLinks([kube], 5)).toEqual([join(root, "config-target")]);
    await rm(root, { recursive: true, force: true });
  });
});

describe("socketHolding", () => {
  it("refuses system socket folders, a socket anywhere inside, and a tree too large to check", async () => {
    expect(await socketHolding("/run/docker.sock")).toMatch(/system sockets/);
    expect(await socketHolding("/run/user/1000")).toMatch(/system sockets/);
    const root = await realpath(await mkdtemp("/tmp/chat-holding-"));
    await mkdir(join(root, "a", "b", "c", "d"), { recursive: true });
    expect(await socketHolding(root)).toBeNull();
    const server = createServer();
    const socket = join(root, "a", "b", "c", "d", "s");
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    expect(await socketHolding(root)).toContain(socket);
    expect(await socketHolding(socket)).toMatch(/is a socket/);
    expect(await socketHolding(root, 2)).toMatch(/too large/);
    await new Promise((resolve) => server.close(resolve));
    await rm(join(root, "a"), { recursive: true, force: true });
    // A named pipe counts too, and a folder that cannot be listed is not taken as empty.
    execFileSync("/usr/bin/mkfifo", [join(root, "pipe")]);
    expect(await socketHolding(root)).toMatch(/socket or pipe/);
    await rm(join(root, "pipe"));
    await mkdir(join(root, "locked"));
    await chmod(join(root, "locked"), 0o311);
    expect(await socketHolding(root)).toMatch(/cannot be checked/);
    await chmod(join(root, "locked"), 0o755);
    await rm(root, { recursive: true, force: true });
  });
});

describe("socketsUnder", () => {
  it("finds the sockets a few levels into readable folders", async () => {
    const root = await realpath(await mkdtemp("/tmp/chat-sockets-"));
    await mkdir(join(root, "ibus"), { recursive: true });
    const socket = join(root, "ibus", "dbus-1");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    await writeFile(join(root, "plain"), "");
    expect(await socketsUnder([root])).toEqual([socket]);
    expect(await socketsUnder([root], 1)).toEqual([]);
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
});

describe("windowsSigner", () => {
  it("names the keygen wrapper to git after the config already set", () => {
    const ssh = {
      bin: "C:\\c\\bin",
      wrapper: "C:\\c\\bin\\ssh.cmd",
      keygen: "C:\\c\\bin\\ssh-keygen.cmd",
    };
    expect(windowsSigner({ GIT_CONFIG_COUNT: "2" }, ssh)).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "gpg.ssh.program",
      GIT_CONFIG_VALUE_2: "C:\\c\\bin\\ssh-keygen.cmd",
    });
    expect(windowsSigner({ GIT_CONFIG_COUNT: "2" }, { ...ssh, keygen: null })).toEqual({});
  });
});

describe("local services", () => {
  it("is refused on Linux, where it could change nothing", async () => {
    const { sandbox, close } = await harness(async () => fakeProcess().process, "linux");
    const chat = { origin: "https://chat.example", conversationId: "chat-a" };
    const exit = await Effect.runPromiseExit(
      sandbox.approveCapability({ scope: "chat", chat }, "local-services"),
    );
    expect(JSON.stringify(exit)).toContain(
      "On Linux commands reach their own local services already.",
    );
    await close();
  });

  it("opens loopback only for the answers it applies to", async () => {
    const requests: ContainerRequest[] = [];
    const { sandbox, close } = await harness(async (request) => {
      requests.push(request);
      const child = fakeProcess();
      child.finish(0);
      return child.process;
    });
    const chat = { origin: "https://chat.example", conversationId: "chat-a" };
    await Effect.runPromise(sandbox.run(run()));
    await Effect.runPromise(sandbox.approveCapability({ scope: "chat", chat }, "local-services"));
    await Effect.runPromise(sandbox.run(run()));
    await Effect.runPromise(
      sandbox.run(run({ context: { ...chat, conversationId: "chat-b", attempt: "a" } })),
    );
    expect(requests.map((request) => request.network?.ingress)).toEqual([
      { default: "deny", hostLoopback: "deny" },
      { default: "allow", hostLoopback: "allow" },
      { default: "deny", hostLoopback: "deny" },
    ]);
    await close();
  });
});

describe("JVM settings", () => {
  it("routes Gradle and Maven through the proxy without the token in any JVM's arguments", async () => {
    let request: ContainerRequest | undefined;
    let settings = "";
    let gradle = "";
    const { sandbox, close } = await harness(async (sent) => {
      request = sent;
      const file = /^-s (\S+)/.exec(sent.environment?.MAVEN_ARGS ?? "")?.[1] ?? "";
      settings = await readFile(file, "utf8");
      gradle = await readFile((sent.environment?.GRADLE_OPTS ?? "").slice(1), "utf8");
      const child = fakeProcess();
      child.finish(0);
      return child.process;
    });
    await Effect.runPromise(sandbox.run(run()));
    const env = request?.environment ?? {};
    const token = new URL(request?.network?.runtimeConfig?.networkProxy ?? "").password;
    expect(env.JAVA_TOOL_OPTIONS).toBe("-Djava.net.preferIPv4Stack=true");
    expect(env.GRADLE_USER_HOME).toBe("/w/.cache/gradle");
    // An argument file: the JVM's own arguments, which other processes can list, hold only its path.
    expect(env.GRADLE_OPTS).toMatch(/^@\S+gradle\.args$/);
    expect(gradle.split("\n")).toContain(`-Dhttps.proxyPassword=${token}`);
    expect(gradle.split("\n")).toContain("-Djdk.http.auth.tunneling.disabledSchemes=");
    expect(settings).toContain(`<password>${token}</password>`);
    expect(settings).toContain("<localRepository>/w/.cache/m2</localRepository>");
    // The settings file goes with the command.
    expect(env.MAVEN_ARGS).toContain("-Daether.connector.basic.threads=1");
    const file = /^-s (\S+)/.exec(env.MAVEN_ARGS ?? "")?.[1] ?? "";
    await expect(readFile(file, "utf8")).rejects.toThrow();
    await close();
  });

  it("quotes the files it names on Windows, where profile folders may hold spaces", () => {
    const env = jvmEnvironment(
      "C:\\w\\.cache",
      "C:\\Users\\Jane Doe\\x\\settings.xml",
      "C:\\Users\\Jane Doe\\x\\gradle.args",
      "win32",
    );
    expect(env.MAVEN_ARGS).toBe(
      '-s "C:\\Users\\Jane Doe\\x\\settings.xml" -Daether.connector.basic.threads=1',
    );
    expect(env.GRADLE_OPTS).toBe('"@C:\\Users\\Jane Doe\\x\\gradle.args"');
  });
});

describe("the SSH agent", () => {
  it("is granted per chat only", async () => {
    const { sandbox, close } = await harness(async () => fakeProcess().process);
    const chat = { origin: "https://chat.example", conversationId: "chat-a" };
    for (const target of [
      { scope: "always" } as const,
      { scope: "answer", answer: { ...chat, attempt: "a" } } as const,
    ]) {
      const exit = await Effect.runPromiseExit(sandbox.approveCapability(target, "ssh-agent"));
      expect(JSON.stringify(exit)).toContain("per chat only");
    }
    await Effect.runPromise(sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"));
    await close();
  });

  it("is refused where no agent runs", async () => {
    const chat = { origin: "https://chat.example", conversationId: "chat-a" };
    const none = await harness(
      async () => {
        throw new Error("must not launch");
      },
      "darwin",
      () => proxyCapable,
      { agent: async () => null },
    );
    expect(
      JSON.stringify(
        await Effect.runPromiseExit(
          none.sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"),
        ),
      ),
    ).toContain("No SSH agent was found. Start one, or choose it in Settings › This computer.");
    await none.close();
  });

  for (const os of ["darwin", "linux", "win32"] as const)
    it(`carries the agent through the proxy for that chat only, never naming it (${os})`, async () => {
      // A socket stands in for the user's agent: the proxy only connects to the path.
      const socket = join(await directory(), "agent.sock");
      const agentServer = createServer((client) => client.once("data", () => client.write("keys")));
      await new Promise<void>((resolve) => agentServer.listen(socket, resolve));
      const launches = [
        Promise.withResolvers<ContainerRequest>(),
        Promise.withResolvers<ContainerRequest>(),
      ];
      const children: ReturnType<typeof fakeProcess>[] = [];
      const { sandbox, close } = await harness(
        async (request) => {
          launches[children.length]?.resolve(request);
          const child = fakeProcess();
          children.push(child);
          return child.process;
        },
        os,
        () => proxyCapable,
        { agent: async () => socket },
      );
      const chat = { origin: "https://chat.example", conversationId: "chat-a" };
      await Effect.runPromise(sandbox.approveCapability({ scope: "chat", chat }, "ssh-agent"));
      const allowed = Effect.runPromise(sandbox.run(run({ callId: "allowed" })));
      const mine = await launches[0]?.promise;
      const other = Effect.runPromise(
        sandbox.run(
          run({ callId: "other", context: { ...chat, conversationId: "chat-b", attempt: "a" } }),
        ),
      );
      const theirs = await launches[1]?.promise;
      // The socket is never named to the container: no path grant, no environment variable.
      // Denied, so not even a command that finds it can open it (a Windows pipe is no path);
      // named nowhere else.
      if (os !== "win32") expect(mine?.filesystem?.deniedPaths).toContain(socket);
      const named = JSON.stringify([
        mine?.filesystem?.readwritePaths,
        mine?.filesystem?.readonlyPaths,
        mine?.environment,
      ]);
      expect(named).not.toContain(socket);
      expect(mine?.environment?.SSH_AUTH_SOCK).toBeUndefined();
      const agent = "ssh-agent.invalid:1";
      const raw = (request?: ContainerRequest) =>
        request?.network?.runtimeConfig?.networkProxy ?? "";
      // On Linux the port is reachable by anyone local; the bridge proves the command with the
      // token kept in its private folder, beside the ssh wrapper.
      const url = async (request?: ContainerRequest) => {
        const bin = request?.environment?.PATH?.split(":")[0] ?? "";
        const key = await readFile(join(dirname(bin), "proxy.key"), "utf8").catch(() => null);
        return key ? raw(request).replace("http://", `http://cmd:${key}@`) : raw(request);
      };
      expect(await connectThrough(await url(mine), agent)).toMatch(/^HTTP\/1\.1 200/);
      expect(await connectThrough(await url(theirs), agent)).toMatch(/^HTTP\/1\.1 403/);
      if (os === "linux") expect(await connectThrough(raw(mine), agent)).toMatch(/^HTTP\/1\.1 403/);
      await Effect.runPromise(sandbox.revokeCapability({ scope: "chat", chat }, "ssh-agent"));
      expect(await connectThrough(await url(mine), agent)).toMatch(/^HTTP\/1\.1 403/);
      for (const child of children) child.finish(0);
      // The agent is a switch of its own: its refusal never asks for a network grant.
      expect((await other).violations).toEqual([
        "refused network-outbound ssh-agent.invalid:1: This chat has not allowed signing in with the SSH agent.",
      ]);
      await allowed;
      await close();
      await new Promise<void>((resolve) => agentServer.close(() => resolve()));
    });

  it("points git at the wrapper, whatever ssh its config names", async () => {
    // Needs a real ssh on this machine's PATH for the wrapper to be written.
    if (!existsSync("/usr/bin/ssh")) return;
    const child = fakeProcess();
    const { launch, launched } = launcher(child.process);
    const { sandbox, close } = await harness(launch);
    const result = Effect.runPromise(sandbox.run(run()));
    const environment = (await launched).environment ?? {};
    child.finish(0);
    await result;
    const bin = environment.PATH?.split(":")[0] ?? "";
    expect(environment.GIT_SSH_COMMAND).toBe(`"${join(bin, "ssh")}"`);
    await close();
  });
});
