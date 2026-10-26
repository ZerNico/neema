import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** What a VM is created with. Everything a chat's VM sees comes from here. */
export interface VmSpec {
  readonly name: string;
  readonly image: string;
  readonly cpus: number;
  readonly memoryMib: number;
  /** A formatted ext4 image on the host holding the VM's writable layer: its installs. */
  readonly rootDisk: string;
  readonly mounts: ReadonlyArray<{ guest: string; host: string; readOnly: boolean }>;
  readonly egress: {
    /** `127.0.0.1:port` of the CONNECT proxy every TCP connection goes to. */
    readonly proxy: string;
    readonly username: string;
    /** The host environment variable holding the token; the guest never sees it. */
    readonly tokenVariable: string;
    /** `127.0.0.1:port` of the VM's own name listener, its only DNS. */
    readonly dns: string;
  };
  /** A host socket (a named pipe on Windows) the guest reaches on this vsock port. */
  readonly vsock?: { readonly host: string; readonly port: number };
  readonly labels: Readonly<Record<string, string>>;
}

export interface ExecRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: Buffer;
}

export interface GuestEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly size: number;
  readonly modified: Date | null;
}

/** A running VM. Paths are guest paths. */
export interface Guest {
  /** Runs to completion and collects everything. For short helper commands only. */
  run(request: ExecRequest): Promise<{ code: number; stdout: Buffer; stderr: Buffer }>;
  /** Streams output as it comes; resolves with the exit code. */
  stream(request: ExecRequest, onOutput: (chunk: Buffer) => void): Promise<number>;
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer | string): Promise<void>;
  list(path: string): Promise<GuestEntry[]>;
  /** Null when nothing is there. */
  stat(path: string): Promise<GuestEntry | null>;
  copyFromHost(host: string, guest: string): Promise<void>;
  stop(): Promise<void>;
}

export interface Hypervisor {
  /** Creates the VM by name, replacing a stale record of the same name, and starts it. */
  start(spec: VmSpec): Promise<Guest>;
  /** Removes a VM's record; its root disk is the caller's. Missing is not an error. */
  destroy(name: string): Promise<void>;
  /** Names of VMs carrying this label, running or not. */
  named(label: string, value: string): Promise<string[]>;
  /** Puts an empty ext4 filesystem in a sparse file, using a throwaway VM of the image. */
  formatDisk(path: string, image: string): Promise<void>;
}

type Microsandbox = typeof import("microsandbox");
type Sandbox = Awaited<ReturnType<Microsandbox["Sandbox"]["get"]>>;
type Running = Awaited<ReturnType<ReturnType<Microsandbox["Sandbox"]["builder"]>["create"]>>;
type RootDisk = InstanceType<Microsandbox["RootDiskBuilder"]>;
type Dns = InstanceType<Microsandbox["DnsBuilder"]>;

const entryOf = (entry: {
  path: string;
  kind: GuestEntry["kind"];
  size: number;
  modified: Date | null;
}): GuestEntry => ({
  path: entry.path,
  kind: entry.kind,
  size: entry.size,
  modified: entry.modified,
});

const guestOf = (vm: Running): Guest => ({
  async run({ argv: [command, ...args], cwd, env, stdin }) {
    const output = await vm.execWith(command, (builder) => {
      let next = builder.args(args);
      if (cwd) next = next.cwd(cwd);
      if (env) next = next.envs({ ...env });
      return stdin ? next.stdinBytes(stdin) : next.stdinNull();
    });
    return {
      code: output.code,
      stdout: Buffer.from(output.stdoutBytes()),
      stderr: Buffer.from(output.stderrBytes()),
    };
  },
  async stream({ argv: [command, ...args], cwd, env }, onOutput) {
    const handle = await vm.execStreamWith(command, (builder) => {
      let next = builder.args(args).stdinNull();
      if (cwd) next = next.cwd(cwd);
      return env ? next.envs({ ...env }) : next;
    });
    // The exit arrives as the stream's last event; once read there, wait() has none left.
    let exit: number | undefined;
    for (;;) {
      const event = await handle.recv();
      if (!event) break;
      if (event.kind === "stdout" || event.kind === "stderr") onOutput(Buffer.from(event.data));
      else if (event.kind === "exited") exit = event.code;
    }
    return exit ?? (await handle.wait()).code;
  },
  read: async (path) => Buffer.from(await vm.fs().read(path)),
  write: (path, data) => vm.fs().write(path, data),
  list: async (path) => (await vm.fs().list(path)).map(entryOf),
  async stat(path) {
    const fs = vm.fs();
    if (!(await fs.exists(path))) return null;
    const meta = await fs.stat(path);
    return { path, kind: meta.kind, size: meta.size, modified: meta.modified };
  },
  copyFromHost: (host, guest) => vm.fs().copyFromHost(host, guest),
  stop: () => vm.stop(),
});

/**
 * microsandbox, loaded on first use so a machine that cannot run it still opens the app.
 * `insecureRegistry` lets development pull the image from a plain-HTTP local registry.
 */
export const microsandbox = (
  load: () => Promise<Microsandbox>,
  options: { insecureRegistry?: boolean } = {},
): Hypervisor => {
  let loaded: Promise<Microsandbox> | undefined;
  const sdk = () => (loaded ??= load());
  const remove = async (name: string) => {
    const { Sandbox } = await sdk();
    let handle: Sandbox;
    try {
      handle = await Sandbox.get(name);
    } catch {
      return;
    }
    await handle.destroy({ force: true });
  };
  return {
    async start(spec) {
      const { Sandbox, NetworkPolicy, MiB } = await sdk();
      let builder = Sandbox.builder(spec.name)
        .imageWith((image) =>
          image.oci(spec.image).rootDisk((disk: RootDisk) => disk.disk(spec.rootDisk)),
        )
        .cpus(spec.cpus)
        .memory(MiB(spec.memoryMib))
        .labels({ ...spec.labels })
        .registry((registry) => (options.insecureRegistry ? registry.insecure() : registry))
        .replace()
        .proxy((proxy) =>
          proxy
            .httpConnect(spec.egress.proxy)
            .credentials(spec.egress.username, { kind: "env", var: spec.egress.tokenVariable }),
        )
        .network((network) =>
          network
            // Placeholders are private addresses by design; the answers are ours.
            .dns((dns: Dns) => dns.nameservers([spec.egress.dns]).rebindProtection(false))
            .policyFromBuilder(
              NetworkPolicy.builder()
                .defaultDeny()
                // Every TCP connection; the proxy decides each one.
                .egress((rule) => rule.tcp().allowPublic().allowPrivate())
                // DNS goes only to the gateway, which hands it to the name listener.
                .egress((rule) => rule.udp().tcp().port(53).allowHost()),
            ),
        );
      for (const mount of spec.mounts)
        builder = builder.volume(mount.guest, (volume) => {
          const bound = volume.bind(mount.host).hostPermissions("mirror");
          return mount.readOnly ? bound.readonly() : bound;
        });
      if (spec.vsock) builder = builder.vsock(spec.vsock.host, spec.vsock.port);
      return guestOf(await builder.create());
    },
    destroy: remove,
    async named(label, value) {
      const { Sandbox } = await sdk();
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await Sandbox.listWith((list) => {
          const labelled = list.label(label, value).limit(100);
          return cursor ? labelled.cursor(cursor) : labelled;
        });
        names.push(...page.sandboxes.map((sandbox) => sandbox.name));
        cursor = page.nextCursor;
      } while (cursor);
      return names;
    },
    async formatDisk(path, image) {
      const { Sandbox, MiB } = await sdk();
      const name = `format-${randomUUID()}`;
      const helper = await Sandbox.builder(name)
        .image(image)
        .registry((registry) => (options.insecureRegistry ? registry.insecure() : registry))
        .memory(MiB(512))
        .replace()
        .network((network) => network.enabled(false))
        .volume("/disk", (volume) => volume.bind(dirname(path)))
        .create();
      try {
        const output = await helper.execWith("mkfs.ext4", (builder) =>
          builder.args(["-q", "-F", `/disk/${basename(path)}`]).stdinNull(),
        );
        if (output.code !== 0) throw new Error(`mkfs failed: ${output.stderr().trim()}`);
      } finally {
        await helper.stop().catch(() => {});
        await remove(name).catch(() => {});
      }
    },
  };
};
