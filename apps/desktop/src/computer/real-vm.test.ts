import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createEgressProxy, type EgressProxy } from "@chat/egress-proxy";
import { runCommand } from "./exec.ts";
import {
  deletePaths,
  editTextFile,
  findFiles,
  listFolder,
  readTextFile,
  searchFiles,
  writeTextFile,
} from "./files.ts";
import { microsandbox, type Guest } from "./hypervisor.ts";
import { ChatVms, type ChatKey } from "./vms.ts";
import type { Mount } from "./paths.ts";

/**
 * Real VMs, opt-in: set NEEMA_VM_IMAGE to the sandbox image (a local registry build works with
 * NEEMA_VM_INSECURE=1). Needs a machine microsandbox runs on. CI has no nested virtualization
 * on macOS, so this runs where a person runs it.
 */
const IMAGE = process.env.NEEMA_VM_IMAGE;
const KEY: ChatKey = {
  origin: "https://real.test",
  conversationId: "0190f0aa-0000-7000-8000-00000000beef",
};

describe.skipIf(!IMAGE)("a chat's computer on a real VM", () => {
  let root: string;
  let vms: ChatVms;
  let proxy: EgressProxy;
  let workspace: string;
  let site: string;
  let refs: string;
  const denials: string[] = [];
  const mounts = (): Mount[] => [
    { name: "site", hostPath: site, readOnly: false },
    { name: "refs", hostPath: refs, readOnly: true },
  ];

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "real-vm-")));
    workspace = join(root, "workspace");
    site = join(root, "site");
    refs = join(root, "refs");
    for (const dir of [workspace, site, refs]) await mkdir(dir, { recursive: true });
    await writeFile(join(site, "app.ts"), "export const answer = 41;\n");
    await writeFile(join(refs, "notes.md"), "read only\n");
    proxy = createEgressProxy({
      decide: (_context, host, port) =>
        ["pypi.org:443", "files.pythonhosted.org:443"].includes(`${host}:${port}`)
          ? { allowed: true, grantId: `${host}:${port}` }
          : { allowed: false, reason: "No grant for host:port" },
      onDenial: (denial) => denials.push(`${denial.host}:${denial.port}`),
      log: () => {},
    });
    await proxy.listen();
    vms = new ChatVms({
      hypervisor: microsandbox(() => import("microsandbox"), {
        insecureRegistry: process.env.NEEMA_VM_INSECURE === "1",
      }),
      egress: proxy,
      image: IMAGE!,
      disks: join(root, "disks"),
      diskMib: 4096,
      cpus: 2,
      memoryMib: 2048,
      idleMs: 60_000,
    });
  }, 300_000);

  afterAll(async () => {
    await vms?.discard(KEY);
    await vms?.stopAll();
    await proxy?.close();
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  const use = <A>(fn: (guest: Guest) => Promise<A>) =>
    vms.use(KEY, { workspace, mounts: mounts() }, fn);

  test("file tools work on the guest's paths", async () => {
    await use(async (guest) => {
      const listing = await listFolder(guest, mounts(), ".");
      expect(listing.entries.map((entry) => entry.name)).toEqual([
        "/workspace",
        "/folders/site",
        "/folders/refs (read-only)",
      ]);
      expect((await readTextFile(guest, mounts(), "/folders/site/app.ts")).text).toBe(
        "export const answer = 41;\n",
      );
      const edit = await editTextFile(guest, mounts(), {
        path: "/folders/site/app.ts",
        old: "41",
        new: "42",
      });
      expect(edit.replacements).toBe(1);
      await writeTextFile(guest, mounts(), "/workspace/today.md", "# Today\n");
      expect((await findFiles(guest, mounts(), "*.md")).paths).toEqual(
        expect.arrayContaining(["/workspace/today.md", "/folders/refs/notes.md"]),
      );
      expect((await findFiles(guest, mounts(), "/folders/refs/**/*")).paths).toEqual([
        "/folders/refs/notes.md",
      ]);
      // A pattern across the roots searches each one it reaches, and only those.
      expect((await findFiles(guest, mounts(), "/folders/**/*.md")).paths).toEqual([
        "/folders/refs/notes.md",
      ]);
      await expect(findFiles(guest, mounts(), "/etc/*")).rejects.toThrow(/outside/);
      const search = await searchFiles(guest, mounts(), "answer = \\d+");
      expect(search.matches).toEqual([
        { path: "/folders/site/app.ts", line: 1, text: "export const answer = 42;" },
      ]);
      await expect(writeTextFile(guest, mounts(), "/folders/refs/new.md", "x")).rejects.toThrow(
        /read-only/,
      );
      const removed = await deletePaths(guest, mounts(), [
        "/workspace/today.md",
        "/workspace/missing",
      ]);
      expect(removed.deleted).toEqual([{ path: "/workspace/today.md", kind: "file" }]);
      expect(removed.failed).toHaveLength(1);
    });
    expect(await readFile(join(site, "app.ts"), "utf8")).toBe("export const answer = 42;\n");
    expect((await stat(join(site, "app.ts"))).mode & 0o777).toBe(0o644);
  }, 300_000);

  test("commands reach only granted destinations and leave nothing running", async () => {
    const outcome = await use((guest) =>
      runCommand(guest, {
        command:
          "pip download -q --no-deps -d /tmp/dl six && ls /tmp/dl; curl -sS -m 5 https://example.com -o /dev/null || echo refused; (setsid sleep 1000 &) ; echo done",
        cwd: "/workspace",
        timeoutMs: 120_000,
        outputLimit: 32_000,
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toMatch(/six-.*\.whl/);
    expect(outcome.output).toMatch(/refused/);
    expect(denials).toContain("example.com:443");
    const left = await use((guest) =>
      runCommand(guest, {
        command: "pgrep -x sleep || echo none",
        cwd: "/workspace",
        timeoutMs: 10_000,
        outputLimit: 1_000,
      }),
    );
    expect(left.output.trim()).toBe("none");
  }, 300_000);

  test("commands get the image's Python, and pip installs into it", async () => {
    const outcome = await use((guest) =>
      runCommand(guest, {
        command:
          "command -v python3 && pip install -q six && python3 -c 'import six; print(six.__file__)'",
        cwd: "/workspace",
        timeoutMs: 120_000,
        outputLimit: 4_000,
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("/opt/venv/bin/python3");
    expect(outcome.output).toContain("/opt/venv/lib/python3.14/site-packages/six.py");
  }, 300_000);

  test("Stop ends a command and everything it started", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 1_000);
    const outcome = await use((guest) =>
      runCommand(guest, {
        command: "setsid sleep 1001 & nohup sleep 1002 >/dev/null 2>&1 & sleep 1003; wait",
        cwd: "/workspace",
        timeoutMs: 60_000,
        signal: controller.signal,
        outputLimit: 1_000,
      }),
    );
    expect(outcome.stopped).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 120_000);

  test("a Stop before the command started means it never runs", async () => {
    for (const when of ["before", "racing"] as const) {
      const controller = new AbortController();
      if (when === "before") controller.abort();
      const outcome = await use(async (guest) => {
        const running = runCommand(guest, {
          command: `touch /workspace/ran-${when}`,
          cwd: "/workspace",
          timeoutMs: 60_000,
          signal: controller.signal,
          outputLimit: 1_000,
        });
        // In the same tick: the kill reaches the guest before the wrapper made its group.
        controller.abort();
        return running;
      });
      expect(outcome.stopped).toBe(true);
      const ran = await use((guest) =>
        runCommand(guest, {
          command: `test -e /workspace/ran-${when} && echo ran || echo never`,
          cwd: "/workspace",
          timeoutMs: 60_000,
          outputLimit: 1_000,
        }),
      );
      expect(ran.output.trim()).toBe("never");
    }
  }, 120_000);

  test("installs survive a folder change, which recreates the VM", async () => {
    await use((guest) =>
      runCommand(guest, {
        command: "echo kept > /usr/local/share/marker",
        cwd: "/workspace",
        timeoutMs: 10_000,
        outputLimit: 1_000,
      }),
    );
    const other = await realpath(await mkdtemp(join(root, "other-")));
    const outcome = await vms.use(
      KEY,
      { workspace, mounts: [{ name: "other", hostPath: other, readOnly: false }] },
      (guest) =>
        runCommand(guest, {
          command: "cat /usr/local/share/marker; ls /folders",
          cwd: "/workspace",
          timeoutMs: 10_000,
          outputLimit: 1_000,
        }),
    );
    expect(outcome.output.trim().split("\n")).toEqual(["kept", "other"]);
  }, 300_000);
});
