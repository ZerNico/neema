import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Guest, Hypervisor, VmSpec } from "./hypervisor.ts";
import { ChatVms, ORIGIN_LABEL, originLabel, vmName, type ChatKey } from "./vms.ts";

const KEY: ChatKey = {
  origin: "https://chat.example",
  conversationId: "0190f0aa-0000-7000-8000-000000000001",
};

class FakeTimers {
  private next = 0;
  readonly pending = new Map<number, () => void>();
  setTimeout = (fn: () => void) => {
    const id = ++this.next;
    this.pending.set(id, fn);
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.pending.delete(id as number);
  };
  fire() {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const fn of due) fn();
  }
}

/** Records what was asked of the hypervisor; a started VM answers runs with nothing. */
const fakeHypervisor = () => {
  const started: VmSpec[] = [];
  const stopped: string[] = [];
  const destroyed: string[] = [];
  const formatted: string[] = [];
  const tokenSeen: Array<string | undefined> = [];
  const hypervisor: Hypervisor = {
    async start(spec) {
      started.push(spec);
      tokenSeen.push(process.env[spec.egress.tokenVariable]);
      const guest: Guest = {
        run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
        stream: async () => 0,
        read: async () => Buffer.alloc(0),
        write: async () => {},
        list: async () => [],
        stat: async () => null,
        copyFromHost: async () => {},
        stop: async () => {
          stopped.push(spec.name);
        },
      };
      return guest;
    },
    destroy: async (name) => {
      destroyed.push(name);
    },
    formatDisk: async (path) => {
      formatted.push(path);
    },
    prepare: async () => {},
  };
  return { hypervisor, started, stopped, destroyed, formatted, tokenSeen };
};

const fakeEgress = () => {
  const issued: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  return {
    issued,
    revoked,
    egress: {
      issue: async () => {
        const token = `token-${++n}`;
        issued.push(token);
        return { token, username: "vm", proxy: "127.0.0.1:1", dns: "127.0.0.1:2" };
      },
      revoke: (token: string) => {
        revoked.push(token);
      },
    },
  };
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const setup = async (image = "registry/image@sha256:a") => {
  const disks = await mkdtemp(join(tmpdir(), "vms-test-"));
  dirs.push(disks);
  const hv = fakeHypervisor();
  const eg = fakeEgress();
  const timers = new FakeTimers();
  const vms = new ChatVms({
    hypervisor: hv.hypervisor,
    egress: eg.egress,
    image,
    disks,
    diskMib: 64,
    cpus: 2,
    memoryMib: 2048,
    idleMs: 300_000,
    timers,
  });
  return { vms, hv, eg, timers, disks };
};

const plain = { workspace: "/host/ws", mounts: [] };

test("the first use makes and formats the chat's disk, then starts its VM with the workspace", async () => {
  const { vms, hv, disks } = await setup();
  await vms.use(KEY, plain, async () => {});
  const disk = join(disks, `${vmName(KEY)}.img`);
  expect(hv.formatted).toEqual([disk]);
  expect((await stat(disk)).size).toBe(64 * 1024 * 1024);
  expect(JSON.parse(await readFile(`${disk}.json`, "utf8"))).toEqual({
    image: "registry/image@sha256:a",
  });
  expect(hv.started).toHaveLength(1);
  expect(hv.started[0]).toMatchObject({
    rootDisk: disk,
    mounts: [{ guest: "/workspace", host: "/host/ws", readOnly: false }],
    labels: { [ORIGIN_LABEL]: originLabel(KEY.origin) },
  });
});

test("the egress token is in the environment only while the VM starts", async () => {
  const { vms, hv, eg } = await setup();
  await vms.use(KEY, plain, async () => {});
  expect(hv.tokenSeen).toEqual([eg.issued[0]]);
  expect(process.env[hv.started[0]!.egress.tokenVariable]).toBeUndefined();
});

test("the same mounts reuse the VM; other mounts recreate it on the same disk", async () => {
  const { vms, hv, eg } = await setup();
  await vms.use(KEY, plain, async () => {});
  await vms.use(KEY, plain, async () => {});
  expect(hv.started).toHaveLength(1);
  const withFolder = {
    workspace: "/host/ws",
    mounts: [{ name: "site", hostPath: "/host/site", readOnly: true }],
  };
  await vms.use(KEY, withFolder, async () => {});
  expect(hv.started).toHaveLength(2);
  expect(hv.stopped).toEqual([vmName(KEY)]);
  expect(eg.revoked).toEqual([eg.issued[0]]);
  expect(hv.started[1]!.mounts).toContainEqual({
    guest: "/folders/site",
    host: "/host/site",
    readOnly: true,
  });
  expect(hv.started[1]!.rootDisk).toBe(hv.started[0]!.rootDisk);
  expect(hv.formatted).toHaveLength(1);
});

test("operations on one chat run one at a time", async () => {
  const { vms } = await setup();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = vms.use(KEY, plain, async () => {
    order.push("first start");
    await gate;
    order.push("first end");
  });
  const second = vms.use(KEY, plain, async () => {
    order.push("second");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(order).toEqual(["first start"]);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(["first start", "first end", "second"]);
});

test("a failed operation does not block the next", async () => {
  const { vms } = await setup();
  await expect(vms.use(KEY, plain, async () => Promise.reject(new Error("boom")))).rejects.toThrow(
    "boom",
  );
  await expect(vms.use(KEY, plain, async () => "ok")).resolves.toBe("ok");
});

test("an idle VM stops and the next use starts it again", async () => {
  const { vms, hv, timers } = await setup();
  await vms.use(KEY, plain, async () => {});
  expect(vms.running(KEY)).toBe(true);
  timers.fire();
  await vms.stop(KEY);
  expect(vms.running(KEY)).toBe(false);
  expect(hv.stopped).toEqual([vmName(KEY)]);
  await vms.use(KEY, plain, async () => {});
  expect(hv.started).toHaveLength(2);
});

test("a new image starts the chat over on a fresh disk, and the next use is told once", async () => {
  const first = await setup("image@sha256:a");
  // A chat's first disk is not a reset.
  expect(await first.vms.use(KEY, plain, async (_, info) => info.reset)).toBe(false);
  const second = new ChatVms({
    hypervisor: first.hv.hypervisor,
    egress: first.eg.egress,
    image: "image@sha256:b",
    disks: first.disks,
    diskMib: 64,
    cpus: 2,
    memoryMib: 2048,
    idleMs: 300_000,
    timers: first.timers,
  });
  expect(await second.use(KEY, plain, async (_, info) => info.reset)).toBe(true);
  expect(first.hv.formatted).toHaveLength(2);
  expect(await second.use(KEY, plain, async (_, info) => info.reset)).toBe(false);
});

test("discard removes the VM and its disk", async () => {
  const { vms, hv, disks } = await setup();
  await vms.use(KEY, plain, async () => {});
  await vms.discard(KEY);
  expect(hv.destroyed).toEqual([vmName(KEY)]);
  await expect(stat(join(disks, `${vmName(KEY)}.img`))).rejects.toThrow(/ENOENT/);
});

test("after stopAll nothing new starts", async () => {
  const { vms } = await setup();
  await vms.use(KEY, plain, async () => {});
  await vms.stopAll();
  expect(vms.running(KEY)).toBe(false);
  await expect(vms.use(KEY, plain, async () => {})).rejects.toThrow(/shutting down/);
});
