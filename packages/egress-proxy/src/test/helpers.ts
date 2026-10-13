import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, expect, vi } from "vitest";
import {
  createEgressProxy,
  type CommandContext,
  type Denial,
  type EgressProxy,
  type ProxyOptions,
} from "../index.ts";

export const PUBLIC = "93.184.216.34";
export const PUBLIC6 = "2001:4860:4860::8888";
export const CONTEXT: CommandContext = {
  server: "server-a",
  chat: "chat-a",
  attempt: "attempt-a",
  command: "command-a",
};
/** Marks policy denials so clients and reporting can tell them from network failures. */
export const DENIAL_HEADER = "x-egress-denied";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

export class Clock {
  private now = 0;
  private next = 0;
  /** Monotonic fake time, also the resolver's hosts-cache clock. */
  readonly time = () => this.now;
  private jobs = new Map<number, { at: number; ms: number; fn: () => void }>();
  private registrations: Array<{ ms: number; ready: ReturnType<typeof deferred<void>> }> = [];
  readonly timers = {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++this.next;
      this.jobs.set(id, { at: this.now + ms, ms, fn });
      for (const waiter of this.registrations.filter((w) => w.ms === ms)) waiter.ready.resolve();
      this.registrations = this.registrations.filter((w) => w.ms !== ms);
      return id;
    },
    clearTimeout: (handle: unknown) => {
      if (typeof handle === "number") this.jobs.delete(handle);
    },
  };
  scheduled(ms: number): Promise<void> {
    if ([...this.jobs.values()].some((job) => job.ms === ms)) return Promise.resolve();
    const ready = deferred<void>();
    this.registrations.push({ ms, ready });
    return ready.promise;
  }
  advance(ms: number) {
    const until = this.now + ms;
    for (let count = 0; ; count++) {
      if (count > 10_000) throw new Error("Timer fixture did not quiesce");
      const due = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= until)
        .toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.jobs.delete(due[0]);
      due[1].fn();
    }
    this.now = until;
  }
}

export class Wire {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private chunks: Buffer[] = [];
  private waiters = new Set<() => void>();
  private terminal = false;
  readonly ended: Promise<void>;
  readonly closed: Promise<void>;
  constructor(readonly socket: Socket) {
    const end = deferred<void>();
    const close = deferred<void>();
    this.ended = end.promise;
    this.closed = close.promise;
    socket.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      this.notify();
    });
    const finish = () => {
      this.terminal = true;
      end.resolve();
      this.notify();
    };
    socket.on("end", finish);
    socket.on("close", () => {
      finish();
      close.resolve();
    });
    // Resets are observable through closed and transcript, not unhandled EventEmitter errors.
    socket.on("error", () => {});
  }
  get transcript() {
    return Buffer.concat(this.chunks);
  }
  private notify() {
    for (const waiter of this.waiters) waiter();
  }
  private waitFor<T>(read: () => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const attempt = () => {
        const result = read();
        if (result !== undefined) {
          this.waiters.delete(attempt);
          resolve(result);
        } else if (this.terminal) {
          this.waiters.delete(attempt);
          reject(new Error("Socket ended before expected bytes"));
        }
      };
      this.waiters.add(attempt);
      attempt();
    });
  }
  private take(n: number): Buffer {
    const pieces: Buffer[] = [];
    let remaining = n;
    while (remaining > 0) {
      const first = this.pending.shift()!;
      const length = Math.min(first.length, remaining);
      pieces.push(first.subarray(0, length));
      if (length < first.length) this.pending.unshift(first.subarray(length));
      remaining -= length;
    }
    this.pendingBytes -= n;
    return Buffer.concat(pieces, n);
  }
  read(n: number): Promise<Buffer> {
    return this.waitFor(() => (this.pendingBytes >= n ? this.take(n) : undefined));
  }
  async head() {
    const raw = await this.waitFor(() => {
      const end = Buffer.concat(this.pending, this.pendingBytes).indexOf("\r\n\r\n");
      if (end < 0) return;
      return this.take(end + 4).toString("latin1");
    });
    const [statusLine = "", ...lines] = raw.trimEnd().split("\r\n");
    expect(statusLine).toMatch(/^HTTP\/1\.[01] \d{3}(?: |$)/);
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      expect(colon).toBeGreaterThan(0);
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { status: Number(statusLine.split(" ")[1]), headers, raw };
  }
  async rest() {
    await this.ended;
    return this.take(this.pendingBytes);
  }
  async finish() {
    await this.ended;
    this.socket.end();
    await this.closed;
  }
}

export function auth(token: string, username = "cmd") {
  return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}
export function request(
  target: string,
  authorization?: string,
  extraHeaders: string[] = [],
  method = "CONNECT",
) {
  const headers = ["Host: proxy.test", ...extraHeaders];
  if (authorization !== undefined) headers.push(`Proxy-Authorization: ${authorization}`);
  return Buffer.from(`${method} ${target} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
}
export function write(socket: Socket, bytes: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const tasks = cleanups.splice(0).toReversed();
  try {
    for (const cleanup of tasks) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

export async function fixture(options: Partial<ProxyOptions> = {}) {
  const clock = new Clock();
  const denials: Denial[] = [];
  const dials: Array<{ address: string; port: number; family: 4 | 6; socket: Socket }> = [];
  const wires: Wire[] = [];
  const peers: Wire[] = [];
  const pendingPeers: Array<ReturnType<typeof deferred<Wire>>> = [];
  const queuedPeers: Wire[] = [];
  let upstreamPort = 0;
  const resolve = vi.fn(options.resolve ?? (async () => [{ address: PUBLIC, family: 4 as const }]));
  const decide = vi.fn(
    options.decide ??
      ((_context, host, port) => ({
        allowed: host === "example.com" && port === 443,
        grantId: "grant-a",
        reason: "No grant for host:port",
      })),
  );
  const onDenial = vi.fn((denial: Denial) => {
    denials.push(denial);
    options.onDenial?.(denial);
  });
  const interfaceAddresses = vi.fn(options.interfaceAddresses ?? (() => ["192.0.2.10"]));
  const connect = vi.fn((address: string, port: number, family: 4 | 6) => {
    const socket = options.connect
      ? options.connect(address, port, family)
      : createConnection({ host: "127.0.0.1", port: upstreamPort, allowHalfOpen: true });
    socket.on("error", () => {});
    dials.push({ address, port, family, socket });
    return socket;
  });
  // Construct first so options the proxy rejects fail before any socket is opened.
  const proxy = createEgressProxy({
    ...options,
    decide,
    onDenial,
    resolve,
    connect,
    interfaceAddresses,
    timers: options.timers ?? clock.timers,
  });
  let proxyClosed = false;
  async function close() {
    if (proxyClosed) return;
    await proxy.close();
    proxyClosed = true;
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const wire = new Wire(socket);
    peers.push(wire);
    const waiter = pendingPeers.shift();
    if (waiter) waiter.resolve(wire);
    else queuedPeers.push(wire);
  });
  cleanups.push(async () => {
    for (const wire of [...wires, ...peers]) wire.socket.destroy();
    for (const dial of dials) dial.socket.destroy();
    await close();
    if (server.listening)
      await new Promise<void>((yes, no) => server.close((error) => (error ? no(error) : yes())));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP upstream address");
  upstreamPort = address.port;
  const { port } = await proxy.listen();
  const issued = proxy.issue(CONTEXT);
  async function client() {
    const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    const wire = new Wire(socket);
    wires.push(wire);
    await once(socket, "connect");
    return wire;
  }
  async function open(target = "example.com:443", token = issued.token, early = Buffer.alloc(0)) {
    const wire = await client();
    await write(wire.socket, Buffer.concat([request(target, auth(token)), early]));
    return wire;
  }
  async function peer() {
    const existing = queuedPeers.shift();
    if (existing) return existing;
    const ready = deferred<Wire>();
    pendingPeers.push(ready);
    return ready.promise;
  }
  return {
    proxy,
    port,
    ...issued,
    clock,
    denials,
    onDenial,
    decide,
    resolve,
    connect,
    interfaceAddresses,
    dials,
    peers,
    client,
    open,
    peer,
    close,
    upstreamPort,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function response(wire: Wire, status: number | number[], denial = false) {
  const head = await wire.head();
  expect(Array.isArray(status) ? status : [status]).toContain(head.status);
  expect(head.headers[DENIAL_HEADER]).toBe(denial ? "1" : undefined);
  if (denial) expect(head.headers["content-type"]).toMatch(/^text\/plain(?:;|$)/i);
  if (head.status === 407) expect(head.headers["proxy-authenticate"]).toMatch(/^Basic(?: |$)/i);
  const body = (await wire.rest()).toString("utf8");
  await wire.finish();
  return { ...head, body };
}
export async function established(f: Fixture, target = "example.com:443", token = f.token) {
  const client = await f.open(target, token);
  const head = await client.head();
  expect(head.status).toBe(200);
  expect(head.headers[DENIAL_HEADER]).toBeUndefined();
  const peer = await f.peer();
  return { client, peer };
}
export function allow(grantId = "grant-a", privateNetwork = false) {
  return { allowed: true, grantId, privateNetwork };
}
export function answer(address: string): ReadonlyArray<{ address: string; family: 4 | 6 }> {
  return [{ address, family: address.includes(":") ? 6 : 4 }];
}
export async function noTunnels(proxy: EgressProxy) {
  await turn();
  expect(proxy.tunnels()).toEqual([]);
}

/** Runtime values outside the helpers' string signatures, each labelled for a test name. */
export const nonStrings: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["a number", 42],
  ["an object", {}],
  ["an array", []],
  ["a symbol", Symbol("host")],
  ["an object with a length", { length: 1 }],
];
