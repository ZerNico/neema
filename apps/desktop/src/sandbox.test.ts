import { connect } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { loadEgressGrants } from "./egress-grants.ts";
import { loadPathGrants } from "./path-grants.ts";
import { loadScopedGrants } from "./scoped-grants.ts";
import { commandEnvironment } from "./sandbox-environment.ts";
import {
  filesystemPolicy,
  makeSandbox,
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

  it("writes only the attached folders, the workspace and the user's own temp folders", () => {
    expect(policy.readwritePaths).toEqual([
      "/work/project",
      "/profile/workspaces/chat",
      "/var/folders/xy/T",
      "/dev/null",
    ]);
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

  it("omits a POSIX TMPDIR on Windows", () => {
    expect(commandEnvironment({}, "C:\\w", proxy, "win32").TMPDIR).toBeUndefined();
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

const harness = async (launch: SandboxDependencies["launch"]) => {
  const root = await directory();
  const grants = await loadEgressGrants(root);
  const paths = await loadPathGrants(root, { home, denied: [root] });
  const local = await loadScopedGrants(root, "local-grants.json", (entry) => entry === "local");
  const dependencies: SandboxDependencies = {
    os: "darwin",
    support: () => ({ isSupported: true, availableMethods: ["seatbelt"] }),
    launch,
    grants,
    paths,
    local,
    userFolders: () => [],
  };
  const scope = await Effect.runPromise(Scope.make());
  const sandbox = await Effect.runPromise(Scope.provide(makeSandbox(dependencies), scope));
  return {
    sandbox,
    grants,
    paths,
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
    const { sandbox, close } = await harness(launch);
    const result = Effect.runPromise(sandbox.run(run({ command: "echo 'it''s'" })));
    const request = await launched;
    child.stdout.write("hi\n");
    child.finish(0);
    expect(await result).toEqual({ exitCode: 0, output: "hi\n", truncated: false, violations: [] });
    expect(request).toMatchObject({
      command: `/bin/sh -c 'echo '\\''it'\\'''\\''s'\\'''`,
      workingDirectory: "/w",
      timeoutMs: 60_000,
      network: { egress: { default: "deny" }, ingress: { hostLoopback: "deny" } },
    });
    // The workspace, the command's own private folder and /dev/null.
    const [workspace, own, devNull, ...rest] = request.filesystem?.readwritePaths ?? [];
    expect([workspace, devNull, rest]).toEqual(["/w", "/dev/null", []]);
    expect(own).toMatch(/neema-command-/);
    const proxyUrl = request.network?.runtimeConfig?.networkProxy ?? "";
    expect(proxyUrl).toMatch(/^http:\/\/cmd:[^@]+@127\.0\.0\.1:\d+$/);
    expect(request.environment?.HTTPS_PROXY).toBe(proxyUrl);
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
          launch: async () => {
            throw new Error("must not launch");
          },
          grants,
          paths: null,
          local: null,
          userFolders: () => [],
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
    await Effect.runPromise(sandbox.approveLocal(target));
    expect(await Effect.runPromise(sandbox.permissions(target))).toEqual({
      network: [site],
      paths: [granted],
      local: true,
    });
    await Effect.runPromise(sandbox.forgetChat(chat));
    expect(await Effect.runPromise(sandbox.permissions(target))).toEqual({
      network: [],
      paths: [],
      local: false,
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

  it("refuses home and credentials before asking anything of the store", async () => {
    const { sandbox, close } = await harness(async () => fakeProcess().process);
    for (const path of [home, join(home, ".ssh")]) {
      const exit = await Effect.runPromiseExit(sandbox.approvePath({ scope: "always" }, path));
      expect(exit).toMatchObject({ _tag: "Failure" });
    }
    await close();
  });
});

describe("local services", () => {
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
    await Effect.runPromise(sandbox.approveLocal({ scope: "chat", chat }));
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
  it("routes Gradle and Maven through the proxy without putting the token in JAVA_TOOL_OPTIONS", async () => {
    let request: ContainerRequest | undefined;
    let settings = "";
    const { sandbox, close } = await harness(async (sent) => {
      request = sent;
      const file = /^-s (\S+)/.exec(sent.environment?.MAVEN_ARGS ?? "")?.[1] ?? "";
      settings = await readFile(file, "utf8");
      const child = fakeProcess();
      child.finish(0);
      return child.process;
    });
    await Effect.runPromise(sandbox.run(run()));
    const env = request?.environment ?? {};
    const token = new URL(request?.network?.runtimeConfig?.networkProxy ?? "").password;
    expect(env.JAVA_TOOL_OPTIONS).toBe("-Djava.net.preferIPv4Stack=true");
    expect(env.GRADLE_USER_HOME).toBe("/w/.cache/gradle");
    expect(env.GRADLE_OPTS).toContain(`-Dhttps.proxyPassword=${token}`);
    expect(env.GRADLE_OPTS).toContain("-Djdk.http.auth.tunneling.disabledSchemes=");
    expect(settings).toContain(`<password>${token}</password>`);
    expect(settings).toContain("<localRepository>/w/.cache/m2</localRepository>");
    // The settings file goes with the command.
    expect(env.MAVEN_ARGS).toContain("-Daether.connector.basic.threads=1");
    const file = /^-s (\S+)/.exec(env.MAVEN_ARGS ?? "")?.[1] ?? "";
    await expect(readFile(file, "utf8")).rejects.toThrow();
    await close();
  });
});
