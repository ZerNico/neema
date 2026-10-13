import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createEgressProxy } from "../index.ts";
import * as resolverModule from "../resolver.ts";
import { readHostsFile, type HostsHandle } from "../resolver.ts";
import {
  allow,
  answer,
  auth,
  Clock,
  CONTEXT,
  deferred,
  fakeResolver,
  PUBLIC,
  PUBLIC6,
  request,
  response,
  turn,
  Wire,
  write,
} from "./helpers.ts";

// Default resolution uses c-ares only; any getaddrinfo lookup fails the test instead of reaching the network.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => {
    throw new Error("getaddrinfo is forbidden");
  }),
}));

test("c-ares queries both absolute families with a bounded timeout and stable order", async () => {
  const f = fakeResolver();
  const result = f.resolve("example.com", new AbortController().signal);
  const checked = expect(result).resolves.toEqual([
    ...answer(PUBLIC),
    ...answer("93.184.216.35"),
    ...answer(PUBLIC6),
  ]);
  await turn();
  expect(f.createResolver).toHaveBeenCalledExactlyOnceWith({ timeout: 37, tries: 1 });
  expect(f.instances[0]?.queries.map(({ host, family }) => ({ host, family }))).toEqual([
    { host: "example.com.", family: 4 },
    { host: "example.com.", family: 6 },
  ]);
  f.complete(6, [PUBLIC6]);
  f.complete(4, [PUBLIC, "93.184.216.35"]);
  await checked;
  f.clock.advance(37);
  expect(f.instances[0]?.cancel).not.toHaveBeenCalled();
});

test("hosts aliases match exact case-insensitive names before DNS", async () => {
  const f = fakeResolver(
    `# comment\r\n${PUBLIC} primary EXAMPLE.com other # comment\r\n${PUBLIC6}\texample.COM\nnot-an-ip example.com\n127.0.0.1 notexample.com\n`,
  );
  expect(await f.resolve("example.com", new AbortController().signal)).toEqual([
    ...answer(PUBLIC),
    ...answer(PUBLIC6),
  ]);
  expect(f.readHosts).toHaveBeenCalledExactlyOnceWith("/fake/hosts", 65_536);
  expect(f.createResolver).not.toHaveBeenCalled();
});

test("parsed hosts are cached for five monotonic seconds, then read again", async () => {
  const f = fakeResolver(`${PUBLIC} example.com`);
  expect(await f.resolve("example.com", new AbortController().signal)).toEqual(answer(PUBLIC));
  f.readHosts.mockResolvedValue(Buffer.from(`${PUBLIC6} example.com`));
  f.clock.advance(4_999);
  expect(await f.resolve("EXAMPLE.com", new AbortController().signal)).toEqual(answer(PUBLIC));
  expect(f.readHosts).toHaveBeenCalledTimes(1);
  f.clock.advance(1);
  expect(await f.resolve("example.com", new AbortController().signal)).toEqual(answer(PUBLIC6));
  expect(f.readHosts).toHaveBeenCalledTimes(2);
  expect(f.createResolver).not.toHaveBeenCalled();
});

for (const hostEntry of [
  "notexample.com",
  "sub.example.com",
  "*.example.com",
  "example.com.evil",
  "# example.com",
]) {
  test(`hosts entry ${hostEntry} cannot match example.com`, async () => {
    const f = fakeResolver(`${PUBLIC} ${hostEntry}`);
    const result = f.resolve("example.com", new AbortController().signal);
    const checked = expect(result).resolves.toEqual(answer(PUBLIC6));
    await turn();
    f.complete(4, [], "ENODATA");
    f.complete(6, [PUBLIC6]);
    await checked;
  });
}

test("oversized hosts input fails closed before parsing or DNS", async () => {
  const f = fakeResolver(`${PUBLIC} example.com\n${" ".repeat(65_536)}`);
  await expect(f.resolve("example.com", new AbortController().signal)).rejects.toThrow();
  expect(f.readHosts).toHaveBeenCalledExactlyOnceWith("/fake/hosts", 65_536);
  expect(f.createResolver).not.toHaveBeenCalled();
});

test("a missing hosts file falls back to DNS", async () => {
  const f = fakeResolver();
  f.readHosts.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
  const result = f.resolve("example.com", new AbortController().signal);
  const checked = expect(result).resolves.toEqual(answer(PUBLIC));
  await turn();
  f.complete(4, [PUBLIC]);
  f.complete(6, [], "ENOTFOUND");
  await checked;
});

test("unreadable hosts input fails closed rather than bypassing it", async () => {
  const f = fakeResolver();
  f.readHosts.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
  await expect(f.resolve("example.com", new AbortController().signal)).rejects.toThrow();
  expect(f.readHosts).toHaveBeenCalledTimes(1);
  expect(f.createResolver).not.toHaveBeenCalled();
});

test("one DNS family failure cancels pending work and rejects the lookup", async () => {
  const f = fakeResolver();
  const result = f.resolve("example.com", new AbortController().signal);
  const checked = expect(result).rejects.toThrow();
  await turn();
  f.complete(4, [], "ESERVFAIL");
  await checked;
  expect(f.instances[0]?.cancel).toHaveBeenCalledTimes(1);
  f.complete(6, [PUBLIC6]);
});

test("the lookup deadline cancels c-ares even if its callbacks never settle", async () => {
  const f = fakeResolver();
  const result = f.resolve("example.com", new AbortController().signal);
  const checked = expect(result).rejects.toThrow();
  await turn();
  expect(f.instances[0]?.queries).toHaveLength(2);
  f.clock.advance(37);
  await checked;
  expect(f.instances[0]?.cancel).toHaveBeenCalledTimes(1);
});

test("aborting one lookup cancels only its per-request resolver", async () => {
  const f = fakeResolver();
  const controller = new AbortController();
  const first = f.resolve("example.com", controller.signal);
  const firstChecked = expect(first).rejects.toThrow();
  const second = f.resolve("example.com", new AbortController().signal);
  const secondChecked = expect(second).resolves.toEqual(answer(PUBLIC));
  await turn();
  expect(f.instances).toHaveLength(2);
  controller.abort();
  await firstChecked;
  expect(f.instances[0]?.cancel).toHaveBeenCalledTimes(1);
  expect(f.instances[1]?.cancel).not.toHaveBeenCalled();
  f.complete(4, [PUBLIC], undefined, 1);
  f.complete(6, [], "ENODATA", 1);
  await secondChecked;
});

for (const stop of ["abort", "deadline"] as const) {
  test(`${stop} during hosts reading prevents late DNS work`, async () => {
    const f = fakeResolver();
    const hosts = deferred<Buffer>();
    f.readHosts.mockReturnValueOnce(hosts.promise);
    const controller = new AbortController();
    const result = f.resolve("example.com", controller.signal);
    const checked = expect(result).rejects.toThrow();
    await turn();
    expect(f.readHosts).toHaveBeenCalledTimes(1);
    if (stop === "abort") controller.abort();
    else f.clock.advance(37);
    await checked;
    hosts.resolve(Buffer.alloc(0));
    await turn();
    expect(f.createResolver).not.toHaveBeenCalled();
  });
}

for (const stop of ["EOF", "deadline", "revoke", "regrant", "shutdown"] as const) {
  test(`proxy ${stop} cancels its default resolver`, async () => {
    const f = fakeResolver();
    const createDefaultResolver = resolverModule.createDefaultResolver;
    vi.spyOn(resolverModule, "createDefaultResolver").mockImplementation((ms, timers) =>
      createDefaultResolver(ms, timers, f.dependencies),
    );
    let allowed = true;
    const connect = vi.fn(() => {
      throw new Error("must not dial");
    });
    const proxy = createEgressProxy({
      decide: () => (allowed ? allow() : { allowed: false }),
      onDenial: vi.fn(),
      log: vi.fn(),
      timers: f.clock.timers,
      limits: { establishMs: 37 },
      interfaceAddresses: () => [],
      connect,
    });
    const { port } = await proxy.listen();
    const { token } = proxy.issue(CONTEXT);
    const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    const client = new Wire(socket);
    try {
      await once(socket, "connect");
      await write(socket, request("example.com:443", auth(token)));
      // The establishment timer is registered once the request is parsed: an I/O barrier, not a wait.
      await f.clock.scheduled(37);
      await turn();
      expect(f.instances[0]?.queries).toHaveLength(2);
      if (stop === "EOF") {
        socket.end();
        await client.closed;
      }
      if (stop === "deadline") {
        f.clock.advance(37);
        await response(client, 502);
      }
      if (stop === "revoke") {
        proxy.revoke(token);
        await client.finish();
      }
      if (stop === "regrant") {
        allowed = false;
        proxy.regrant("grant-a");
        await response(client, 403, true);
      }
      if (stop === "shutdown") {
        await proxy.close();
        await client.finish();
      }
      expect(f.instances[0]?.cancel).toHaveBeenCalledTimes(1);
      f.complete(4, [PUBLIC]);
      f.complete(6, [PUBLIC6]);
      await turn();
      expect(connect).not.toHaveBeenCalled();
      expect(proxy.tunnels()).toEqual([]);
    } finally {
      socket.destroy();
      await proxy.close();
    }
  });
}

test("platform hosts paths use the Windows system root or the Unix hosts file", () => {
  expect(resolverModule.systemHostsPath("win32", "D:\\OS")).toBe(
    "D:\\OS\\System32\\drivers\\etc\\hosts",
  );
  expect(resolverModule.systemHostsPath("linux", "D:\\OS")).toBe("/etc/hosts");
  expect(resolverModule.systemHostsPath("darwin")).toBe("/etc/hosts");
});

test("hosts input exactly at the 64 KiB cap remains usable", async () => {
  const entry = `${PUBLIC} example.com\n#`;
  const f = fakeResolver(entry + " ".repeat(65_536 - Buffer.byteLength(entry)));
  expect(await f.resolve("example.com", new AbortController().signal)).toEqual(answer(PUBLIC));
  expect(f.createResolver).not.toHaveBeenCalled();
});

test("an already abandoned lookup starts neither hosts I/O nor DNS", async () => {
  const f = fakeResolver();
  const controller = new AbortController();
  controller.abort();
  await expect(f.resolve("example.com", controller.signal)).rejects.toThrow();
  expect(f.readHosts).not.toHaveBeenCalled();
  expect(f.createResolver).not.toHaveBeenCalled();
});

test("single-label DNS names are absolute and never gain a search domain", async () => {
  const f = fakeResolver();
  const result = f.resolve("intranet", new AbortController().signal);
  await turn();
  expect(f.instances[0]?.queries.map(({ host }) => host)).toEqual(["intranet.", "intranet."]);
  f.complete(4, [], "ENOTFOUND");
  f.complete(6, [], "ENOTFOUND");
  expect(await result).toEqual([]);
});

test("default hosts answers still pass through the address guard", async () => {
  const f = fakeResolver("127.0.0.1 example.com");
  const createDefaultResolver = resolverModule.createDefaultResolver;
  vi.spyOn(resolverModule, "createDefaultResolver").mockImplementation((ms, timers) =>
    createDefaultResolver(ms, timers, f.dependencies),
  );
  const onDenial = vi.fn();
  const connect = vi.fn(() => {
    throw new Error("must not dial");
  });
  const proxy = createEgressProxy({
    decide: () => allow(),
    onDenial,
    connect,
    log: vi.fn(),
    interfaceAddresses: () => [],
    timers: f.clock.timers,
  });
  const { port } = await proxy.listen();
  const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
  const client = new Wire(socket);
  try {
    await once(socket, "connect");
    await write(socket, request("example.com:443", auth(proxy.issue(CONTEXT).token)));
    await response(client, 403, true);
    expect(onDenial).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(f.createResolver).not.toHaveBeenCalled();
  } finally {
    socket.destroy();
    await proxy.close();
  }
});

test("names are queried fully qualified through the resolver seam", async () => {
  const queries: string[] = [];
  const resolve = resolverModule.createDefaultResolver(30_000, new Clock().timers, {
    hostsPath: "/fake/hosts",
    readHosts: async () => Buffer.alloc(0),
    createResolver: () => ({
      resolve4: (host, callback) => {
        queries.push(host);
        callback(null, [PUBLIC]);
      },
      resolve6: (host, callback) => {
        queries.push(host);
        callback(null, []);
      },
      cancel: vi.fn(),
    }),
  });
  expect(await resolve("example.com", new AbortController().signal)).toEqual(answer(PUBLIC));
  expect(queries).toEqual(["example.com.", "example.com."]);
});

test("abandon-and-retry against a stalled hosts read keeps exactly one read outstanding", async () => {
  const f = fakeResolver();
  const stalled = deferred<Buffer>();
  f.readHosts.mockReturnValue(stalled.promise);
  let lookups = 0;
  const original = resolverModule.createDefaultResolver;
  vi.spyOn(resolverModule, "createDefaultResolver").mockImplementation((ms, timers) => {
    const resolve = original(ms, timers, f.dependencies);
    return (host, signal) => {
      lookups++;
      return resolve(host, signal);
    };
  });
  const connect = vi.fn(() => {
    throw new Error("injected dial failure");
  });
  const proxy = createEgressProxy({
    decide: () => allow(),
    onDenial: vi.fn(),
    log: vi.fn(),
    timers: f.clock.timers,
    interfaceAddresses: () => [],
    connect,
    limits: {
      establishMs: 41,
      connectionsTotal: 1,
      tunnelsPerToken: 1,
      tunnelsTotal: 1,
      outstandingResolutionsPerToken: 1,
      outstandingResolutionsTotal: 1,
    },
  });
  const { port } = await proxy.listen();
  const { token } = proxy.issue(CONTEXT);
  const open = async () => {
    const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    const client = new Wire(socket);
    await once(socket, "connect");
    await write(socket, request("example.com:443", auth(token)));
    return client;
  };
  try {
    const cycles = 24;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const client = await open();
      await f.clock.scheduled(41);
      await turn();
      expect(lookups).toBe(cycle + 1);
      // Alternate the two abandonment paths: client EOF and the establishment deadline.
      if (cycle % 2) {
        f.clock.advance(41);
        await response(client, 502);
      } else {
        client.socket.end();
        await client.closed;
      }
      expect(f.readHosts).toHaveBeenCalledTimes(1);
    }
    expect(lookups).toBe(cycles);
    expect(f.createResolver).not.toHaveBeenCalled();
    stalled.resolve(Buffer.from(`${PUBLIC} example.com`));
    await response(await open(), 502);
    expect(connect).toHaveBeenCalledExactlyOnceWith(PUBLIC, 443, 4);
    expect(f.readHosts).toHaveBeenCalledTimes(1);
  } finally {
    await proxy.close();
  }
});

test("concurrent lookups share one read, and abandoning one never cancels it for the others", async () => {
  const f = fakeResolver();
  const hosts = deferred<Buffer>();
  f.readHosts.mockReturnValueOnce(hosts.promise);
  const other = resolverModule.createDefaultResolver(37, f.clock.timers, f.dependencies);
  const controller = new AbortController();
  const abandoned = f.resolve("example.com", controller.signal);
  const abandonedChecked = expect(abandoned).rejects.toThrow();
  const first = f.resolve("example.com", new AbortController().signal);
  const second = other("EXAMPLE.COM", new AbortController().signal);
  await turn();
  expect(f.readHosts).toHaveBeenCalledTimes(1);
  controller.abort();
  await abandonedChecked;
  hosts.resolve(Buffer.from(`${PUBLIC} example.com\n${PUBLIC6} example.com`));
  const both = [...answer(PUBLIC), ...answer(PUBLIC6)];
  expect(await first).toEqual(both);
  expect(await second).toEqual(both);
  expect(f.readHosts).toHaveBeenCalledTimes(1);
  expect(f.createResolver).not.toHaveBeenCalled();
});

test("a failed read is shared by its waiters but never cached", async () => {
  const f = fakeResolver(`${PUBLIC} example.com`);
  const failing = deferred<Buffer>();
  f.readHosts.mockReturnValueOnce(failing.promise);
  const first = f.resolve("example.com", new AbortController().signal);
  const second = f.resolve("example.com", new AbortController().signal);
  const checked = Promise.all([expect(first).rejects.toThrow(), expect(second).rejects.toThrow()]);
  await turn();
  failing.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
  await checked;
  expect(f.readHosts).toHaveBeenCalledTimes(1);
  expect(await f.resolve("example.com", new AbortController().signal)).toEqual(answer(PUBLIC));
  expect(f.readHosts).toHaveBeenCalledTimes(2);
});

function fakeHandle(chunks: Buffer[] | Error) {
  const close = vi.fn(async () => {});
  const read = vi.fn<HostsHandle["read"]>(async (buffer, offset, length) => {
    if (chunks instanceof Error) throw chunks;
    const next = chunks.shift();
    return { bytesRead: next ? next.copy(buffer, offset, 0, length) : 0 };
  });
  const openFile = vi.fn(async (_path: string, _flags: "r"): Promise<HostsHandle> => ({
    read,
    close,
  }));
  return { openFile, read, close };
}

test("the hosts reader closes its handle once after a successful read", async () => {
  const fs = fakeHandle([Buffer.from("1.2.3.4 a\n"), Buffer.from("5.6.7.8 b\n")]);
  expect((await readHostsFile("/fake/hosts", 64, fs.openFile)).toString()).toBe(
    "1.2.3.4 a\n5.6.7.8 b\n",
  );
  expect(fs.openFile).toHaveBeenCalledExactlyOnceWith("/fake/hosts", "r");
  expect(fs.close).toHaveBeenCalledTimes(1);
});

test("the hosts reader closes its handle once after a read error", async () => {
  const fs = fakeHandle(Object.assign(new Error("injected read failure"), { code: "EIO" }));
  await expect(readHostsFile("/fake/hosts", 64, fs.openFile)).rejects.toThrow(
    "injected read failure",
  );
  expect(fs.close).toHaveBeenCalledTimes(1);
});

test("the hosts reader closes its handle once for oversized content", async () => {
  const fs = fakeHandle([Buffer.alloc(5, 0x20), Buffer.alloc(5, 0x20)]);
  await expect(readHostsFile("/fake/hosts", 8, fs.openFile)).rejects.toThrow(/size limit/);
  expect(fs.close).toHaveBeenCalledTimes(1);
});

test("the hosts reader reads a real file at the boundary and refuses one byte more", async () => {
  const directory = mkdtempSync(join(tmpdir(), "egress-hosts-"));
  try {
    const path = join(directory, "hosts");
    writeFileSync(path, "x".repeat(16));
    expect((await readHostsFile(path, 16)).toString()).toBe("x".repeat(16));
    writeFileSync(path, "x".repeat(17));
    await expect(readHostsFile(path, 16)).rejects.toThrow(/size limit/);
    await expect(readHostsFile(join(directory, "missing"), 16)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
