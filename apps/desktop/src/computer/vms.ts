import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientContext, EgressProxy } from "@chat/egress-proxy";
import type { Guest, Hypervisor } from "./hypervisor.ts";
import { FOLDERS, guestRoot, mountKey, WORKSPACE, type Mount } from "./paths.ts";

/** Which chat on which server: the unit a VM, a disk and a set of grants belong to. */
export interface ChatKey {
  readonly origin: string;
  readonly conversationId: string;
}

/** What the VM must show this time: the chat's workspace and attached folders on the host. */
export interface ChatSetup {
  readonly workspace: string;
  readonly mounts: readonly Mount[];
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChatVmsOptions {
  readonly hypervisor: Hypervisor;
  readonly egress: Pick<EgressProxy, "issue" | "revoke">;
  /** The pinned image; a disk made for another image starts over. */
  readonly image: string;
  /** Where the per-chat root disks live. */
  readonly disks: string;
  /** Sparse size of a new root disk. */
  readonly diskMib: number;
  readonly cpus: number;
  readonly memoryMib: number;
  /** A stopped VM costs nothing; a running one some CPU even when idle. */
  readonly idleMs: number;
  /** The host socket the chat's SSH agent relay listens on, exposed on vsock port 5000. */
  readonly agentSocket?: (key: ChatKey) => string;
  readonly timers?: Timers;
  readonly log?: (message: string) => void;
}

/** Guest port the SSH agent relay is reached on; `ssh-agent-bridge` in the image listens there. */
export const AGENT_VSOCK_PORT = 5000;
/** Labels every chat VM carries, so a sweep finds the ones nobody owns anymore. */
export const LABEL = "neema";
export const ORIGIN_LABEL = "neema-origin";

const hash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex");

export const vmName = (key: ChatKey) => `chat-${hash(key.origin, key.conversationId).slice(0, 32)}`;
export const originLabel = (origin: string) => hash(origin).slice(0, 16);

interface Running {
  readonly guest: Guest;
  readonly mounts: string;
  readonly token: string;
}

interface Slot {
  /** The tail of this chat's queue: operations run one at a time. */
  tail: Promise<unknown>;
  running?: Running | undefined;
  idle?: unknown;
}

/**
 * One VM per chat, created when the chat first needs it and stopped when it has been idle. The
 * VM itself is disposable: its root disk on the host holds everything installed, so recreating
 * it with other mounts keeps the chat's environment. Operations on one chat run one at a time,
 * which is also what lets a mount change recreate the VM safely between them.
 */
export class ChatVms {
  private readonly slots = new Map<string, Slot>();
  private readonly timers: Timers;
  private closed = false;

  constructor(private readonly options: ChatVmsOptions) {
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
  }

  /** Runs `fn` with this chat's VM showing exactly `setup`, after the chat's earlier work. */
  use<A>(
    key: ChatKey,
    setup: ChatSetup,
    fn: (guest: Guest) => Promise<A>,
    signal?: AbortSignal,
  ): Promise<A> {
    const slot = this.slot(key);
    const turn = slot.tail.then(async () => {
      if (this.closed) throw new Error("The computer is shutting down");
      signal?.throwIfAborted();
      if (slot.idle !== undefined) this.timers.clearTimeout(slot.idle);
      slot.idle = undefined;
      try {
        const guest = await this.ensure(key, slot, setup);
        signal?.throwIfAborted();
        return await fn(guest);
      } finally {
        this.armIdle(key, slot);
      }
    });
    slot.tail = turn.catch(() => {});
    return turn;
  }

  /** Stops the chat's VM, keeping its disk. */
  stop(key: ChatKey): Promise<void> {
    const slot = this.slots.get(vmName(key));
    if (!slot) return Promise.resolve();
    const turn = slot.tail.then(() => this.halt(key, slot));
    slot.tail = turn.catch(() => {});
    return turn;
  }

  /** The chat is gone or reset: its VM and disk go, so the next use starts from the image. */
  discard(key: ChatKey): Promise<void> {
    const slot = this.slot(key);
    const turn = slot.tail.then(async () => {
      await this.halt(key, slot);
      await this.options.hypervisor.destroy(vmName(key)).catch(() => {});
      const disk = this.diskPath(key);
      await rm(disk, { force: true });
      await rm(`${disk}.json`, { force: true });
    });
    slot.tail = turn.catch(() => {});
    return turn;
  }

  /** On quit: stop every VM once its current operation ends. Disks stay. */
  async stopAll(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.slots.entries()].map(async ([name, slot]) => {
        await slot.tail;
        if (slot.idle !== undefined) this.timers.clearTimeout(slot.idle);
        await this.halt(null, slot, name);
      }),
    );
  }

  /** Removes VMs of this server whose chat is not among `live`, records and disks alike. */
  async sweep(origin: string, live: readonly ChatKey[]): Promise<void> {
    const keep = new Set(live.map(vmName));
    const names = await this.options.hypervisor.named(ORIGIN_LABEL, originLabel(origin));
    for (const name of names.filter((candidate) => !keep.has(candidate))) {
      if (this.slots.has(name)) continue;
      await this.options.hypervisor.destroy(name).catch(() => {});
      const disk = join(this.options.disks, `${name}.img`);
      await rm(disk, { force: true });
      await rm(`${disk}.json`, { force: true });
    }
  }

  running(key: ChatKey) {
    return this.slots.get(vmName(key))?.running !== undefined;
  }

  private slot(key: ChatKey) {
    const name = vmName(key);
    let slot = this.slots.get(name);
    if (!slot) {
      slot = { tail: Promise.resolve() };
      this.slots.set(name, slot);
    }
    return slot;
  }

  private diskPath(key: ChatKey) {
    return join(this.options.disks, `${vmName(key)}.img`);
  }

  private armIdle(key: ChatKey, slot: Slot) {
    if (!slot.running || this.closed) return;
    slot.idle = this.timers.setTimeout(() => {
      slot.idle = undefined;
      void this.stop(key);
    }, this.options.idleMs);
  }

  private async halt(key: ChatKey | null, slot: Slot, name = key ? vmName(key) : "") {
    const running = slot.running;
    if (!running) return;
    slot.running = undefined;
    this.options.egress.revoke(running.token);
    await running.guest.stop().catch((error: unknown) => {
      this.options.log?.(`computer: stopping ${name} failed: ${String(error)}`);
    });
  }

  private async ensure(key: ChatKey, slot: Slot, setup: ChatSetup): Promise<Guest> {
    const mounts = mountKey(setup.workspace, setup.mounts);
    if (slot.running?.mounts === mounts) return slot.running.guest;
    await this.halt(key, slot);
    const rootDisk = await this.disk(key);
    const name = vmName(key);
    const context: ClientContext = { server: key.origin, chat: key.conversationId };
    const client = await this.options.egress.issue(context);
    // microsandbox reads the token from the host environment when the VM starts, so it
    // never appears in the VM's configuration; it is removed again right after.
    const tokenVariable = `NEEMA_EGRESS_${name.slice(5, 21).toUpperCase()}`;
    process.env[tokenVariable] = client.token;
    let guest: Guest;
    try {
      guest = await this.options.hypervisor.start({
        name,
        image: this.options.image,
        cpus: this.options.cpus,
        memoryMib: this.options.memoryMib,
        rootDisk,
        mounts: [
          { guest: WORKSPACE, host: setup.workspace, readOnly: false },
          ...setup.mounts.map((mount) => ({
            guest: guestRoot(mount),
            host: mount.hostPath,
            readOnly: mount.readOnly,
          })),
        ],
        egress: {
          proxy: client.proxy,
          username: client.username,
          tokenVariable,
          dns: client.dns,
        },
        ...(this.options.agentSocket
          ? { vsock: { host: this.options.agentSocket(key), port: AGENT_VSOCK_PORT } }
          : {}),
        labels: { [LABEL]: "chat", [ORIGIN_LABEL]: originLabel(key.origin) },
      });
    } catch (error) {
      this.options.egress.revoke(client.token);
      throw error;
    } finally {
      delete process.env[tokenVariable];
    }
    slot.running = { guest, mounts, token: client.token };
    // Mount points of folders detached since stay behind on the disk as empty folders.
    // A mounted one is busy, so rmdir leaves the current ones alone.
    await guest
      .run({ argv: ["/bin/sh", "-c", `rmdir ${FOLDERS}/* 2>/dev/null; true`] })
      .catch(() => {});
    return guest;
  }

  /** The chat's root disk, made and formatted on first use or when the image changed. */
  private async disk(key: ChatKey) {
    const path = this.diskPath(key);
    const marker = `${path}.json`;
    const made = await readFile(marker, "utf8")
      .then((text) => (JSON.parse(text) as { image?: unknown }).image)
      .catch(() => undefined);
    if (made === this.options.image) return path;
    // Installs made on another image's files would sit on a base they were not made for.
    await mkdir(this.options.disks, { recursive: true });
    await rm(path, { force: true });
    await writeFile(path, "");
    // NTFS allocates a file it extends unless marked sparse first; APFS and ext4 do not.
    if (process.platform === "win32")
      await promisify(execFile)("fsutil", ["sparse", "setflag", path]);
    await truncate(path, this.options.diskMib * 1024 * 1024);
    await this.options.hypervisor.formatDisk(path, this.options.image);
    await writeFile(marker, JSON.stringify({ image: this.options.image }));
    return path;
  }
}
