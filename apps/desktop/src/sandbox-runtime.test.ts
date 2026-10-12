import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runtimeEntry = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime");
const runtimeRoot = dirname(dirname(runtimeEntry));
const execute = promisify(execFile);
let directory: string;
let broker: string;

// Each subprocess imports the installed package unchanged. Only the OS and
// native spawn boundary are synthetic, so sticky manager state stays isolated.
const fixture = String.raw`
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(process.argv[1]);
const calls = [];
const user = { user: { exists: true, sid: 'S-1-5-21-synthetic' }, cred_present: true };
const success = { status: 0, signal: null, stdout: '', stderr: '' };
const command = args => args.slice(1, 3).join(' ');
const reply = (exe, args, options) => {
  if (exe !== input.broker) throw new Error('Unexpected native executable: ' + exe);
  calls.push({ exe, args, input: options?.input });
  const name = command(args);
  if (name === 'user status') return { ...success, stdout: JSON.stringify(user) };
  if (name === 'wfp status') return { ...success, stdout: JSON.stringify({ state: 'installed', filters: 1 }) };
  if (name === 'wfp verify') return { ...success, stdout: JSON.stringify({ egress_probe: 'blocked', target: '127.0.0.1' }) };
  if (name === 'acl grant' || name === 'acl stamp') {
    return { ...success, status: input.failOperation === name ? 2 : 0, stderr: input.failOperation === name ? 'synthetic partial application' : '' };
  }
  if (name === 'acl revoke' || name === 'acl restore') {
    const attempt = calls.filter(call => command(call.args) === name).length;
    const response = input.responses?.[name];
    if (response && !(input.retryEmpty && attempt > 1)) {
      return { ...success, ...response, ...(response.error ? { error: Object.assign(new Error(response.error), { code: response.error }) } : {}) };
    }
    return { ...success, stdout: '[]' };
  }
  throw new Error('Unexpected native command: ' + args.join(' '));
};
childProcess.spawnSync = reply;
childProcess.spawn = (exe, args, options) => {
  const response = reply(exe, args, options);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.end(response.stdout);
    child.stderr.end(response.stderr);
    child.emit('close', response.status, response.signal);
  });
  return child;
};
syncBuiltinESMExports();
Object.defineProperty(process, 'platform', { value: 'win32' });

const originalListen = net.Server.prototype.listen;
let listens = 0;
if (input.networkFailure) {
  net.Server.prototype.listen = function (...args) {
    if (++listens === 2) throw new Error('synthetic proxy bind failure');
    return originalListen.apply(this, args);
  };
}
const listeners = new Map(['exit', 'SIGINT', 'SIGTERM'].map(event => [event, process.listeners(event)]));
const { SandboxManager: manager } = await import(pathToFileURL(input.runtimeEntry).href);
const native = await import(pathToFileURL(input.runtimeRoot + '/dist/sandbox/windows-sandbox-utils.js').href);
const config = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { allowRead: [input.directory], allowWrite: [input.directory], denyRead: [input.directory + '/secret'], denyWrite: [] },
  windows: { srtWin: { path: input.broker }, proxyPortRange: [0, 0] },
  javaAgentJarPath: input.broker,
};
const report = error => ({
  messages: [error.message, ...(error.errors ?? []).flatMap(e => report(e).messages)],
  codes: [error.code, ...(error.errors ?? []).flatMap(e => report(e).codes)].filter(Boolean),
});
const capture = async fn => {
  try { await fn(); return { ok: true, messages: [], codes: [] }; }
  catch (error) { return { ok: false, ...report(error) }; }
};
const result = { first: { ok: true, messages: [], codes: [] }, second: { ok: true, messages: [], codes: [] }, reinitialize: { ok: true, messages: [], codes: [] }, wrap: { ok: true, messages: [], codes: [] }, calls, proxyClosed: false };
try {
  if (input.kind === 'helper') {
    result.first = await capture(() => native[input.operation]({ sandboxUserSid: user.user.sid, holderPid: 123, srtWin: { exe: input.broker, prependArgs: ['--srt-win'] } }));
  } else if (input.kind === 'wrapper') {
    await manager.initialize(config);
    result.first = await capture(() => manager.wrapWithSandboxArgv('echo fixture', 'cmd.exe', { filesystem: input.filesystem }));
    await manager.reset();
  } else {
    result.first = await capture(() => manager.initialize(config));
    const port = manager.getProxyPort();
    if (port !== undefined) {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
    }
    result.second = await capture(() => manager.reset());
    if (port !== undefined) {
      result.proxyClosed = await new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
      });
    }
    if (input.retryEmpty) {
      result.second = await capture(() => manager.reset());
    }
    if (input.retry) {
      net.Server.prototype.listen = originalListen;
      input.failOperation = undefined;
      user.user.sid = 'S-1-5-21-next-session';
      result.reinitialize = await capture(() => manager.initialize({ ...config, filesystem: { ...config.filesystem, allowWrite: [input.runtimeRoot] } }));
      result.wrap = await capture(() => manager.wrapWithSandboxArgv('echo fixture', 'cmd.exe'));
    }
  }
} finally {
  await capture(() => manager.reset());
  net.Server.prototype.listen = originalListen;
  for (const [event, previous] of listeners) {
    for (const listener of process.listeners(event)) {
      if (!previous.includes(listener)) process.removeListener(event, listener);
    }
  }
}
console.log(JSON.stringify(result));
`;

type NativeResponse = { status?: number | null; stdout?: string; error?: string; signal?: string };
type Report = { ok: boolean; messages: string[]; codes: string[] };
type FixtureResult = {
  first: Report;
  second: Report;
  reinitialize: Report;
  wrap: Report;
  calls: { exe: string; args: string[]; input?: string }[];
  proxyClosed: boolean;
};

const runFixture = async (input: {
  kind: "helper" | "wrapper" | "session";
  operation?: "revokeWindowsAcl" | "restoreWindowsAcl";
  responses?: Record<string, NativeResponse>;
  filesystem?: { allowRead?: string[]; allowWrite?: string[] };
  failOperation?: "acl grant" | "acl stamp";
  retry?: boolean;
  retryEmpty?: boolean;
  networkFailure?: boolean;
}) => {
  const { stdout, stderr } = await execute(process.execPath, [
    "--input-type=module",
    "-e",
    fixture,
    JSON.stringify({ ...input, broker, directory, runtimeEntry, runtimeRoot }),
  ]);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as FixtureResult;
};
const aclCalls = (result: FixtureResult) => result.calls.filter((call) => call.args[1] === "acl");
const messages = (report: Report) => report.messages.join("\n");

beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "neema-runtime-contract-")));
  broker = join(directory, "synthetic-srt-win.exe");
  await writeFile(broker, "not an executable");
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("installed Windows sandbox runtime contract", () => {
  it("pins the installed package version", async () => {
    const installed = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
    const desktop = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(installed.version).toBe("0.0.77");
    expect(desktop.dependencies["@anthropic-ai/sandbox-runtime"]).toBe("0.0.77");
  });

  it.each(["allowRead", "allowWrite"] as const)(
    "rejects actual Windows per-exec %s",
    async (key) => {
      const result = await runFixture({
        kind: "wrapper",
        filesystem: { [key]: ["C:\\workspace"] },
      });
      expect(result.first.ok).toBe(false);
      expect(messages(result.first)).toMatch(
        /Per-exec filesystem.allowRead\/allowWrite is not supported/,
      );
      expect(result.calls.some((call) => call.args[1] === "exec")).toBe(false);
    },
  );

  for (const [operation, command] of [
    ["revokeWindowsAcl", "acl revoke"],
    ["restoreWindowsAcl", "acl restore"],
  ] as const) {
    describe(operation, () => {
      it.each([
        ["nonzero with valid JSON", { status: 2, stdout: "[]" }, "srt_win_nonzero"],
        ["signal exit", { status: null, signal: "SIGKILL", stdout: "[]" }, "srt_win_nonzero"],
        ["spawn failure", { error: "ENOENT" }, "spawn_failed"],
        ["spawn timeout", { error: "ETIMEDOUT" }, "srt_win_timeout"],
        ["empty stdout", { stdout: "" }, "srt_win_bad_json"],
        ["invalid JSON", { stdout: "{" }, "srt_win_bad_json"],
        ["missing outcome arrays", { stdout: "{}" }, "acl_cleanup_failed"],
        ["null report", { stdout: "null" }, "acl_cleanup_failed"],
        ["invalid row", { stdout: '[{"path":"C:\\\\fixture"}]' }, "acl_cleanup_failed"],
        ["invalid path", { stdout: '[{"path":false,"status":"revoked"}]' }, "acl_cleanup_failed"],
        ["null row", { stdout: "[null]" }, "acl_cleanup_failed"],
        [
          "retained access",
          { stdout: '[{"path":"C:\\\\fixture","status":"stillHeld"}]' },
          "acl_cleanup_failed",
        ],
        [
          "changed ACL",
          { stdout: '[{"path":"C:\\\\fixture","status":"leftChanged"}]' },
          "acl_cleanup_failed",
        ],
        [
          "unknown status",
          { stdout: '[{"path":"C:\\\\fixture","status":"future-status"}]' },
          "acl_cleanup_failed",
        ],
      ] as const)("rejects %s", async (_name, response, code) => {
        const result = await runFixture({
          kind: "helper",
          operation,
          responses: { [command]: response },
        });
        expect(result.first.ok).toBe(false);
        expect(result.first.codes).toContain(code);
        expect(aclCalls(result)[0]?.args).toContain("123");
      });

      it.each([
        "[]",
        '[{"path":"C:\\\\fixture","status":"revoked"}]',
        '[{"path":"C:\\\\fixture","status":"alreadyOriginal"}]',
      ])(
        "accepts a successful native report %s without inventing path completeness",
        async (stdout) => {
          const result = await runFixture({
            kind: "helper",
            operation,
            responses: { [command]: { stdout } },
          });
          expect(result.first.ok).toBe(true);
        },
      );
    });
  }

  it("accepts legacy restore path and parent outcomes", async () => {
    const result = await runFixture({
      kind: "helper",
      operation: "restoreWindowsAcl",
      responses: {
        "acl restore": {
          stdout: JSON.stringify({
            paths: [{ path: "C:\\child", status: "restored" }],
            parents: [{ path: "C:\\parent", status: "alreadyOriginal" }],
          }),
        },
      },
    });
    expect(result.first.ok).toBe(true);
  });

  it("rejects an anomaly in legacy parent outcomes", async () => {
    const result = await runFixture({
      kind: "helper",
      operation: "restoreWindowsAcl",
      responses: {
        "acl restore": {
          stdout: JSON.stringify({
            paths: [],
            parents: [{ path: "C:\\parent", status: "stillHeld" }],
          }),
        },
      },
    });
    expect(result.first.codes).toContain("acl_cleanup_failed");
  });

  it("attempts both ACL operations and closes the real local proxies before rejecting reset", async () => {
    const result = await runFixture({
      kind: "session",
      responses: { "acl revoke": { error: "ENOENT" }, "acl restore": { status: 2, stdout: "[]" } },
    });
    expect(result.first.ok).toBe(true);
    expect(result.second.codes).toEqual(
      expect.arrayContaining(["spawn_failed", "srt_win_nonzero"]),
    );
    expect(
      aclCalls(result)
        .slice(0, 4)
        .map((call) => call.args[2]),
    ).toEqual(["grant", "stamp", "revoke", "restore"]);
    expect(result.proxyClosed).toBe(true);
  });

  it.each(["acl grant", "acl stamp"] as const)(
    "checks rollback after partial %s failure and allows only clean reuse",
    async (failOperation) => {
      const result = await runFixture({ kind: "session", failOperation, retry: true });
      expect(result.first.ok).toBe(false);
      expect(result.first.codes).toContain(
        failOperation === "acl grant" ? "acl_grant_failed" : "acl_stamp_failed",
      );
      const operations = aclCalls(result).map((call) => call.args[2]);
      expect(
        operations.slice(operations.indexOf("revoke"), operations.indexOf("revoke") + 2),
      ).toEqual(["revoke", "restore"]);
      expect(result.second.ok).toBe(true);
      expect(result.reinitialize.ok).toBe(true);
      expect(result.wrap.ok).toBe(true);
    },
  );

  it.each(["acl grant", "acl stamp"] as const)(
    "retains partial %s cleanup ownership and sticky failure despite empty retry reports",
    async (failOperation) => {
      const result = await runFixture({
        kind: "session",
        failOperation,
        retry: true,
        retryEmpty: true,
        responses: {
          "acl revoke": { stdout: '[{"path":"C:\\\\fixture","status":"stillHeld"}]' },
          "acl restore": { stdout: "{}" },
        },
      });
      expect(messages(result.first)).toContain(
        "initialization failed and cleanup was not confirmed",
      );
      expect(result.first.codes).toEqual(expect.arrayContaining(["acl_cleanup_failed"]));
      expect(result.second.ok).toBe(false);
      expect(result.reinitialize.ok).toBe(false);
      expect(result.wrap.ok).toBe(false);
      const cleanups = aclCalls(result).filter((call) =>
        ["revoke", "restore"].includes(call.args[2]!),
      );
      expect(cleanups.length).toBeGreaterThanOrEqual(6);
      expect(
        cleanups.every((call) => call.exe === broker && call.args.includes("S-1-5-21-synthetic")),
      ).toBe(true);
      expect(result.calls.filter((call) => call.args[1] === "user")).toHaveLength(2);
    },
  );

  it("does not reinterpret empty retry reports as recovery after reset failure", async () => {
    const result = await runFixture({
      kind: "session",
      retry: true,
      retryEmpty: true,
      responses: { "acl restore": { stdout: "" } },
    });
    expect(result.first.ok).toBe(true);
    expect(result.second.codes).toContain("srt_win_bad_json");
    expect(result.reinitialize.ok).toBe(false);
    expect(result.wrap.ok).toBe(false);
    expect(result.proxyClosed).toBe(true);
    expect(aclCalls(result).filter((call) => call.args[2] === "grant")).toHaveLength(1);
  });

  it("awaits checked ACL rollback when proxy initialization fails", async () => {
    const result = await runFixture({
      kind: "session",
      networkFailure: true,
      retry: true,
      retryEmpty: true,
      responses: { "acl revoke": { status: 2, stdout: "[]" } },
    });
    expect(messages(result.first)).toContain("synthetic proxy bind failure");
    expect(messages(result.first)).toContain(
      "network initialization failed and cleanup was not confirmed",
    );
    expect(result.first.codes).toContain("srt_win_nonzero");
    expect(result.second.ok).toBe(false);
    expect(result.reinitialize.ok).toBe(false);
    expect(result.wrap.ok).toBe(false);
    expect(
      aclCalls(result)
        .slice(0, 4)
        .map((call) => call.args[2]),
    ).toEqual(["grant", "stamp", "revoke", "restore"]);
  });

  it("permits a distinct session only after successful checked reset", async () => {
    const result = await runFixture({ kind: "session", retry: true });
    expect(result.first.ok).toBe(true);
    expect(result.second.ok).toBe(true);
    expect(result.proxyClosed).toBe(true);
    expect(result.reinitialize.ok).toBe(true);
    expect(result.wrap.ok).toBe(true);
    const grants = aclCalls(result).filter((call) => call.args[2] === "grant");
    expect(grants).toHaveLength(2);
    expect(JSON.parse(grants[0]!.input!).write).toEqual([directory]);
    expect(JSON.parse(grants[1]!.input!).write).toEqual([runtimeRoot]);
    expect(grants[1]!.args).toContain("S-1-5-21-next-session");
  });
});
