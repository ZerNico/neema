import { Resolver } from "node:dns";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { Deadline, type Timers } from "./timers.ts";

type Address = { address: string; family: 4 | 6 };
type HostsTable = ReadonlyMap<string, ReadonlyArray<Address>>;
type DnsCallback = (error: NodeJS.ErrnoException | null, addresses: string[]) => void;
export interface DnsResolver {
  resolve4(host: string, callback: DnsCallback): void;
  resolve6(host: string, callback: DnsCallback): void;
  cancel(): void;
}
export interface ResolverDependencies {
  readonly createResolver: (options: { timeout: number; tries: number }) => DnsResolver;
  readonly readHosts: (path: string, maxBytes: number) => Promise<Buffer>;
  readonly hostsPath: string;
  /** Monotonic milliseconds for the hosts cache. Defaults to `performance.now`. */
  readonly now?: () => number;
}
export interface HostsHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

const hostsLimit = 65_536;
export const hostsCacheMs = 5_000;

export function systemHostsPath(platform = process.platform, systemRoot = process.env.SystemRoot) {
  return platform === "win32"
    ? win32.join(systemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts")
    : "/etc/hosts";
}

export async function readHostsFile(
  path: string,
  maxBytes: number,
  openFile: (path: string, flags: "r") => Promise<HostsHandle> = open,
): Promise<Buffer> {
  const file = await openFile(path, "r");
  try {
    // One extra byte detects oversize files without trusting a racy stat or reading unbounded data.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("Hosts file exceeds size limit");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

function parseHosts(content: Buffer): HostsTable {
  if (content.length > hostsLimit) throw new Error("Hosts file exceeds size limit");
  const table = new Map<string, Address[]>();
  for (const line of content.toString("utf8").split(/\r?\n/)) {
    const [entry = ""] = line.split("#", 1);
    const [address = "", ...names] = entry.trim().split(/[\t ]+/);
    const family = isIP(address);
    if (family !== 4 && family !== 6) continue;
    for (const name of new Set(names.map((alias) => alias.toLowerCase()))) {
      const answers = table.get(name) ?? [];
      answers.push({ address, family });
      table.set(name, answers);
    }
  }
  return table;
}

type Waiter = { resolve: (table: HostsTable) => void; reject: (error: unknown) => void };

class HostsFile {
  private readonly waiters = new Set<Waiter>();
  private reading = false;
  private cached: { table: HostsTable; at: number } | undefined;
  constructor(private readonly dependencies: ResolverDependencies) {}

  /** An aborted waiter detaches, but the read itself is never cancelled, so at most one is in flight. */
  table(signal: AbortSignal): Promise<HostsTable> {
    const now = this.dependencies.now ?? (() => performance.now());
    if (this.cached && now() - this.cached.at < hostsCacheMs)
      return Promise.resolve(this.cached.table);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.add(waiter);
      signal.addEventListener(
        "abort",
        () => {
          this.waiters.delete(waiter);
          reject(new Error("Hosts lookup abandoned"));
        },
        { once: true },
      );
      if (!this.reading) this.read(now);
    });
  }

  private read(now: () => number) {
    this.reading = true;
    const started = now();
    new Promise<Buffer>((resolve) =>
      resolve(this.dependencies.readHosts(this.dependencies.hostsPath, hostsLimit)),
    )
      .catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return Buffer.alloc(0);
        throw error;
      })
      .then(parseHosts)
      .then(
        (table) => {
          // Age counts from the start of the read, the conservative bound on freshness.
          this.cached = { table, at: started };
          this.settle((waiter) => waiter.resolve(table));
        },
        // Failures are shared with current waiters but never cached, so the next lookup rereads.
        (error: unknown) => this.settle((waiter) => waiter.reject(error)),
      );
  }

  private settle(each: (waiter: Waiter) => void) {
    this.reading = false;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) each(waiter);
  }
}

const systemDependencies: ResolverDependencies = {
  createResolver: (options) => new Resolver(options),
  readHosts: (path, maxBytes) => readHostsFile(path, maxBytes),
  hostsPath: systemHostsPath(),
};
// One cache per dependency set; production shares the system set process-wide.
const hostsFiles = new WeakMap<ResolverDependencies, HostsFile>();

export function createDefaultResolver(
  timeoutMs: number,
  timers: Timers,
  dependencies = systemDependencies,
) {
  let hostsFile = hostsFiles.get(dependencies);
  if (!hostsFile) {
    hostsFile = new HostsFile(dependencies);
    hostsFiles.set(dependencies, hostsFile);
  }
  const hosts = hostsFile;
  return (host: string, signal: AbortSignal): Promise<ReadonlyArray<Address>> =>
    new Promise((resolve, reject) => {
      const deadline = new Deadline(timers);
      const waiting = new AbortController();
      let resolver: DnsResolver | undefined;
      let settled = false;
      const cleanup = () => {
        deadline.clear();
        signal.removeEventListener("abort", abort);
        waiting.abort();
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        // A resolver belongs to one lookup, so cancel never interrupts another connection.
        try {
          resolver?.cancel();
        } finally {
          reject(new Error("DNS resolution failed"));
        }
      };
      const succeed = (answers: ReadonlyArray<Address>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(answers);
      };
      const abort = () => fail();
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      deadline.start(timeoutMs, fail);
      const run = async () => {
        const table = await hosts.table(waiting.signal);
        if (settled) return;
        const answers = table.get(host.toLowerCase());
        if (answers?.length) {
          succeed(answers.map((answer) => ({ ...answer })));
          return;
        }
        const dns = dependencies.createResolver({ timeout: timeoutMs, tries: 1 });
        resolver = dns;
        const query = (family: 4 | 6) =>
          new Promise<Address[]>((yes, no) => {
            const callback: DnsCallback = (error, addresses) => {
              if (error) {
                if (error.code === "ENODATA" || error.code === "ENOTFOUND") yes([]);
                else no(new Error("DNS query failed"));
              } else yes(addresses.map((address) => ({ address, family })));
            };
            if (family === 4) dns.resolve4(`${host}.`, callback);
            else dns.resolve6(`${host}.`, callback);
          });
        // c-ares avoids getaddrinfo's libuv pool. Keep each family's order, A before AAAA.
        const families = await Promise.all([query(4), query(6)]);
        succeed(families.flat());
      };
      void run().catch(fail);
    });
}
