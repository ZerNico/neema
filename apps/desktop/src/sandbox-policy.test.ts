import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { SandboxManager, SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { makeSandbox } from "./sandbox.ts";
import type { runOwnedProcess } from "./process.ts";

const capturedPolicy = async () => {
  const initialize = vi.fn<typeof SandboxManager.initialize>(async () => {});
  const wrap = vi.fn<typeof SandboxManager.wrapWithSandboxArgv>(async () => ({
    argv: ["fake", "--", "true"],
    env: { PATH: "/usr/bin:/bin", NEEMA_SYNTHETIC_TOKEN: "nonsecret" },
  }));
  const execute = vi.fn<typeof runOwnedProcess>(() =>
    Effect.succeed({ code: 0, stdout: "", stderr: "", timedOut: false }),
  );
  const manager = {
    ...SandboxManager,
    initialize,
    wrapWithSandboxArgv: wrap,
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    getSandboxViolationStore: () => new SandboxViolationStore(),
    cleanupAfterCommand: () => {},
    reset: async () => {},
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sandbox = yield* makeSandbox(manager, execute, null, { os: "linux" });
        yield* sandbox.run({
          callId: "fixture",
          command: "true",
          cwd: "/tmp",
          allowWrite: ["/tmp"],
          timeoutMs: 1_000,
        });
      }),
    ),
  );
  return { global: initialize.mock.calls[0]![0]!, perCall: wrap.mock.calls[0]![2]!, execute };
};

const denied = [
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".cargo/config",
  ".cargo/config.toml",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".gradle/gradle.properties",
  ".gradle/init.gradle",
  ".gradle/init.gradle.kts",
  ".gradle/init.d/credentials.gradle",
  ".config/pip/pip.conf",
  ".pip/pip.conf",
  "Library/Application Support/pip/pip.conf",
  ".cache/huggingface/token",
  ".cache/gh/token",
  ".config/git/credentials",
];
const permitted = [
  ".cargo/bin/rust-tool",
  ".cargo/registry/package",
  ".cargo/git/package",
  ".m2/repository/package",
  ".m2/wrapper/tool",
  ".gradle/caches/package",
  ".gradle/wrapper/tool",
  ".gradle/jdks/tool",
  ".gradle/native/tool",
  ".cache/pip/package",
];

describe("toolchain filesystem policy", () => {
  it("narrows config directories and repeats its explicit denies for each command", async () => {
    const policy = await capturedPolicy();
    const fs = policy.global.filesystem;
    const allowRead = fs.allowRead ?? [];
    for (const relative of [".cargo", ".m2", ".gradle", ".config/pip"])
      expect(fs.allowRead).not.toContain(join(homedir(), relative));
    for (const relative of permitted)
      expect(allowRead.some((path) => join(homedir(), relative).startsWith(`${path}/`))).toBe(true);
    for (const relative of denied)
      expect(
        fs.denyRead.some(
          (path) =>
            join(homedir(), relative) === path ||
            (join(homedir(), relative).startsWith(`${path}/`) && path !== homedir()),
        ),
      ).toBe(true);
    expect(policy.perCall.filesystem?.denyRead).toEqual(fs.denyRead);
    expect(policy.perCall.filesystem?.allowRead).toEqual([...allowRead, "/tmp"]);
    expect(policy.execute.mock.calls[0]![0]).toMatchObject({ env: { PATH: "/usr/bin:/bin" } });
    if (process.platform !== "win32")
      expect(policy.execute.mock.calls[0]![0].env).not.toHaveProperty("NEEMA_SYNTHETIC_TOKEN");
  });

  it.skipIf(process.platform !== "darwin")(
    "enforces installed nested denies against synthetic files even under an attached home parent",
    async () => {
      const policy = await capturedPolicy();
      const base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-policy-")));
      const home = join(base, "home");
      const translate = (path: string) => path.replace(homedir(), home);
      try {
        for (const relative of [...denied, ...permitted]) {
          const path = join(home, relative);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, "nonsecret-fixture");
        }
        const paths = [...denied, ...permitted, ".cargo/absent-credentials.toml"].map((path) =>
          join(home, path),
        );
        const nodeScript = `const fs=require("node:fs"); console.log(JSON.stringify(${JSON.stringify(paths)}.map(p=>{try{return fs.readFileSync(p,"utf8")}catch{return null}})))`;
        for (const attached of [false, true]) {
          const wrapped = wrapCommandWithSandboxMacOS({
            command: `'${process.execPath}' -e '${nodeScript}'`,
            needsNetworkRestriction: false,
            readConfig: {
              denyOnly: policy.global.filesystem.denyRead.map(translate),
              allowWithinDeny: [
                ...(policy.global.filesystem.allowRead ?? []).map(translate),
                ...(attached ? [home] : []),
              ],
            },
            writeConfig: { allowOnly: [base], denyWithinAllow: [] },
          });
          const { stdout } = await promisify(execFile)("/bin/bash", ["-c", wrapped], {
            env: { PATH: "/usr/bin:/bin", HOME: home },
            timeout: 2_000,
          });
          expect(JSON.parse(stdout)).toEqual([
            ...denied.map(() => null),
            ...permitted.map(() => "nonsecret-fixture"),
            null,
          ]);
        }
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    },
  );
});
