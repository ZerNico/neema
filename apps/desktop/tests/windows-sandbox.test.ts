import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Exit, Option, Scope } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";
import { makeSandbox, type Sandbox } from "../src/sandbox.ts";

let root: string;
let first: string;
let second: string;
let sandbox: Sandbox["Service"];
let close: (() => Promise<void>) | undefined;

const accessScript = `
const fs = require('node:fs');
const path = require('node:path');
const [own, other] = process.argv.slice(2);
const attempt = f => { try { f(); return true; } catch { return false; } };
console.log(JSON.stringify({
  readOwn: attempt(() => fs.readFileSync(path.join(own, 'fixture.txt'))),
  writeOwn: attempt(() => fs.writeFileSync(path.join(own, 'own.txt'), 'synthetic')),
  readOther: attempt(() => fs.readFileSync(path.join(other, 'fixture.txt'))),
  writeOther: attempt(() => fs.writeFileSync(path.join(other, 'foreign.txt'), 'synthetic')),
}));
`;
const descendantsScript = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [ready, mode] = process.argv.slice(2);
const child = spawn(process.execPath, ['-e', 'process.send(process.pid); setInterval(() => {}, 1000)'], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
child.once('message', pid => {
  fs.writeFileSync(ready + '.tmp', JSON.stringify([process.pid, pid]));
  fs.renameSync(ready + '.tmp', ready);
  child.disconnect();
  child.unref();
  if (mode === 'exit') process.exit(0);
  setInterval(() => {}, 1000);
});
`;

const command = (cwd: string, script: string, args: string[], timeoutMs = 30_000) =>
  sandbox.run({
    callId: crypto.randomUUID(),
    command: `"${process.execPath}" "${join(cwd, script)}" ${args.map((arg) => `"${arg}"`).join(" ")}`,
    cwd,
    allowWrite: [cwd],
    timeoutMs,
  });

const assertAccess = async (own: string, other: string) => {
  const result = await Effect.runPromise(command(own, "access.cjs", [own, other]));
  expect(result.exitCode, result.output).toBe(0);
  expect(JSON.parse(result.output.trim())).toEqual({
    readOwn: true,
    writeOwn: true,
    readOther: false,
    writeOther: false,
  });
};

const waitForReady = (directory: string, filename: string) => {
  const ready = Promise.withResolvers<number[]>();
  const watcher = watch(directory, (_event, name) => {
    if (name !== filename) return;
    void readFile(join(directory, filename), "utf8")
      .then((text) => {
        const pids: unknown = JSON.parse(text);
        if (!Array.isArray(pids) || !pids.every((pid) => Number.isInteger(pid) && pid > 0)) {
          ready.reject(new Error("Invalid native child readiness record"));
          return;
        }
        ready.resolve(pids);
      })
      .catch(ready.reject);
  });
  watcher.on("error", ready.reject);
  return { ready: ready.promise, close: () => watcher.close() };
};

beforeAll(async () => {
  if (
    process.platform !== "win32" ||
    process.env.NEEMA_DISPOSABLE_WINDOWS_RUNNER !== "1" ||
    process.env.GITHUB_ACTIONS !== "true"
  ) {
    throw new Error(
      "This suite provisions the sandbox account and ACLs. Run only in the dedicated disposable Windows CI job.",
    );
  }
  root = await mkdtemp(join(homedir(), "neema-sandbox-native-"));
  first = join(root, "first");
  second = join(root, "second");
  for (const folder of [first, second]) {
    await mkdir(folder);
    await writeFile(join(folder, "fixture.txt"), "synthetic-native-fixture");
    await writeFile(join(folder, "access.cjs"), accessScript);
    await writeFile(join(folder, "descendants.cjs"), descendantsScript);
  }
  const scope = await Effect.runPromise(Scope.make());
  sandbox = await Effect.runPromise(makeSandbox().pipe(Scope.provide(scope)));
  close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const cold = await Effect.runPromise(sandbox.availability());
  expect(["ready", "setup-needed"]).toContain(cold.kind);
  expect(await Effect.runPromise(sandbox.setUp())).toEqual({ kind: "ready" });
});

afterAll(async () => {
  await close?.();
  if (root) await rm(root, { recursive: true, force: true });
});

it("switches actual file access between two session roots", async () => {
  await assertAccess(first, second);
  await assertAccess(second, first);
});

it.each(["exit", "stop", "timeout"] as const)(
  "removes native descendants on %s before the next permission session",
  async (mode) => {
    const filename = `${mode}-ready.json`;
    const readyPath = join(first, filename);
    const readiness = waitForReady(first, filename);
    const controller = new AbortController();
    const pending = Effect.runPromiseExit(command(first, "descendants.cjs", [readyPath, mode]), {
      signal: controller.signal,
    });
    let pids: number[] = [];
    try {
      if (mode !== "exit") {
        pids = await Promise.race([
          readiness.ready,
          pending.then((exit) => {
            throw new Error(`Command ended before child readiness: ${JSON.stringify(exit)}`);
          }),
        ]);
        // A second application host must not acquire the same native account concurrently.
        const helper = new URL("../src/sandbox-windows.ts", import.meta.url).href;
        const probe = `const { windowsSandbox } = await import(${JSON.stringify(helper)}); try { const release = await windowsSandbox.claimHost(); await release(); process.exitCode = 1; } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; }`;
        await promisify(execFile)(process.execPath, ["--input-type=module", "-e", probe]);
        if (mode === "stop") controller.abort();
      }
      const exit = await pending;
      if (mode === "exit") {
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) expect(exit.value.exitCode, exit.value.output).toBe(0);
        pids = await readiness.ready;
      } else if (mode === "stop") {
        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(Exit.hasDies(exit)).toBe(false);
        expect(Option.isNone(Exit.findErrorOption(exit))).toBe(true);
      } else {
        expect(Option.getOrThrow(Exit.findErrorOption(exit)).reason).toBe("timed-out");
        expect(Exit.hasDies(exit)).toBe(false);
      }
      for (const pid of pids)
        expect(() => process.kill(pid, 0), `Native descendant ${pid} survived ${mode}`).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      await assertAccess(second, first);
      for (const pid of pids)
        expect(
          () => process.kill(pid, 0),
          `Native descendant ${pid} entered the next session`,
        ).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      controller.abort();
      await pending;
      readiness.close();
      // Only recorded fixture PIDs, never a process-name sweep on the runner.
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      }
    }
  },
);
