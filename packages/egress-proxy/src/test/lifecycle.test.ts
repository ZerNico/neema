import { createConnection, Socket } from "node:net";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import {
  answer,
  auth,
  Clock,
  deferred,
  established,
  fixture,
  noTunnels,
  PUBLIC,
  request,
  response,
  turn,
  write,
  type Fixture,
} from "./helpers.ts";

function slowResolution() {
  const entered = deferred<void>();
  const result = deferred<ReturnType<typeof answer>>();
  return {
    entered,
    result,
    resolve: () => {
      entered.resolve();
      return result.promise;
    },
  };
}

async function delayedDial() {
  const connected = deferred<void>();
  let release!: () => void;
  let f!: Fixture;
  f = await fixture({
    connect: () => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: f.upstreamPort,
        allowHalfOpen: true,
      });
      const emit = socket.emit.bind(socket);
      // Only delivery of the TCP connect event is gated; all byte I/O uses real sockets.
      vi.spyOn(socket, "emit").mockImplementation((event, ...args) => {
        if (event === "connect") {
          release = () => {
            emit("connect");
          };
          connected.resolve();
          return true;
        }
        return emit(event, ...args);
      });
      return socket;
    },
  });
  return { f, connected: connected.promise, release: () => release() };
}

test("payload in the CONNECT write is delivered exactly once and first", async () => {
  const f = await fixture();
  const initial = Buffer.from([0, 255, 1, 13, 10, 0, 65]);
  const client = await f.open("example.com:443", f.token, initial);
  expect((await client.head()).status).toBe(200);
  const peer = await f.peer();
  await write(client.socket, "second");
  client.socket.end();
  expect(await peer.rest()).toEqual(Buffer.concat([initial, Buffer.from("second")]));
  peer.socket.end("reply");
  expect((await client.rest()).toString()).toBe("reply");
  await Promise.all([client.closed, peer.closed]);
  await noTunnels(f.proxy);
});

test("multiple early writes during resolution preserve byte ordering", async () => {
  const slow = slowResolution();
  const f = await fixture({ resolve: slow.resolve });
  const client = await f.open("example.com:443", f.token, Buffer.from("first"));
  await slow.entered.promise;
  await write(client.socket, "second");
  await write(client.socket, "third");
  expect(client.transcript).toHaveLength(0);
  slow.result.resolve(answer(PUBLIC));
  expect((await client.head()).status).toBe(200);
  const peer = await f.peer();
  client.socket.end();
  expect((await peer.rest()).toString()).toBe("firstsecondthird");
  peer.socket.end();
  await Promise.all([client.closed, peer.closed]);
});

test("bytes arriving during a gated dial follow the initial block", async () => {
  const { f, connected, release } = await delayedDial();
  const client = await f.open("example.com:443", f.token, Buffer.from("a"));
  await connected;
  await write(client.socket, "bc");
  expect(client.transcript).toHaveLength(0);
  release();
  expect((await client.head()).status).toBe(200);
  const peer = await f.peer();
  client.socket.end();
  expect((await peer.rest()).toString()).toBe("abc");
  peer.socket.end();
  await Promise.all([client.closed, peer.closed]);
});

test("EOF during resolution abandons without dialing or replying", async () => {
  const slow = slowResolution();
  const f = await fixture({ resolve: slow.resolve });
  const client = await f.open();
  await slow.entered.promise;
  client.socket.end();
  await client.closed;
  slow.result.resolve(answer(PUBLIC));
  await turn();
  expect(f.connect).not.toHaveBeenCalled();
  expect(client.transcript).toHaveLength(0);
  expect(f.proxy.tunnels()).toEqual([]);
});

test("a reset during resolution makes a late DNS result a no-op", async () => {
  const slow = slowResolution();
  const f = await fixture({ resolve: slow.resolve });
  const client = await f.open();
  await slow.entered.promise;
  client.socket.resetAndDestroy();
  await client.closed;
  await turn();
  slow.result.resolve(answer(PUBLIC));
  await turn();
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.proxy.tunnels()).toEqual([]);
  expect(f.onDenial).not.toHaveBeenCalled();
});

test("a late dial event after abandonment sends nothing and leaves upstream closed", async () => {
  const { f, connected, release } = await delayedDial();
  const client = await f.open("example.com:443", f.token, Buffer.from("must not escape"));
  await connected;
  const peer = await f.peer();
  client.socket.resetAndDestroy();
  await client.closed;
  // The proxy reads the reset asynchronously; one turn is not enough. Abandoning destroys the pending upstream.
  const upstream = f.dials[0]?.socket;
  if (!upstream) throw new Error("Expected a pending dial");
  if (!upstream.destroyed) await once(upstream, "close");
  release();
  await peer.finish();
  expect(peer.transcript).toHaveLength(0);
  expect(client.transcript).toHaveLength(0);
  expect(f.dials[0]?.socket.destroyed).toBe(true);
  await noTunnels(f.proxy);
});

test("a denial to a paused reader survives client EOF and flushes before close", async () => {
  // The long injected policy reason fills ordinary socket buffers, rather than assuming a small 403 blocks.
  const reason = "Denied by policy. ".repeat(256 * 1024);
  const denied = deferred<void>();
  const f = await fixture({
    decide: () => ({ allowed: false, reason }),
    onDenial: () => denied.resolve(),
  });
  const client = await f.client();
  client.socket.pause();
  await write(client.socket, request("example.com:443", auth(f.token)));
  await denied.promise;
  const eofSent = once(client.socket, "finish");
  client.socket.end();
  await eofSent;
  await turn();
  client.socket.resume();
  const result = await response(client, 403, true);
  expect(result.body).toContain("Denied by policy");
  if (result.headers["content-length"] !== undefined)
    expect(Buffer.byteLength(result.body)).toBe(Number(result.headers["content-length"]));
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.onDenial).toHaveBeenCalledTimes(1);
});

test("client EOF is forwarded while the reverse response continues", async () => {
  const f = await fixture();
  const { client, peer } = await established(f);
  client.socket.end("request");
  expect((await peer.rest()).toString()).toBe("request");
  await write(peer.socket, "response after EOF");
  peer.socket.end();
  expect((await client.rest()).toString()).toBe("response after EOF");
  await Promise.all([client.closed, peer.closed]);
  await noTunnels(f.proxy);
});

test("upstream EOF is forwarded while the client can still send", async () => {
  const f = await fixture();
  const { client, peer } = await established(f);
  peer.socket.end("upstream finished");
  expect((await client.rest()).toString()).toBe("upstream finished");
  client.socket.end("client after EOF");
  expect((await peer.rest()).toString()).toBe("client after EOF");
  await Promise.all([client.closed, peer.closed]);
  await noTunnels(f.proxy);
});

test("simultaneous EOF closes both directions without leaked tunnels", async () => {
  const f = await fixture();
  const { client, peer } = await established(f);
  client.socket.end("from client");
  peer.socket.end("from upstream");
  expect((await client.rest()).toString()).toBe("from upstream");
  expect((await peer.rest()).toString()).toBe("from client");
  await Promise.all([client.closed, peer.closed]);
  await noTunnels(f.proxy);
  expect(f.onDenial).not.toHaveBeenCalled();
});

for (const direction of ["upstream-to-client", "client-to-upstream"] as const) {
  test(`${direction} backpressure blocks a finite burst until the reader resumes`, async () => {
    const f = await fixture();
    const tunnel = await established(f);
    const sender = direction === "upstream-to-client" ? tunnel.peer : tunnel.client;
    const receiver = direction === "upstream-to-client" ? tunnel.client : tunnel.peer;
    receiver.socket.pause();
    const bytes = Buffer.alloc(64 * 1024 * 1024, 0x5a);
    let flushed = false;
    const sent = write(sender.socket, bytes).then(() => {
      flushed = true;
    });
    // An equally large independent transfer gives the blocked writer I/O opportunities without sleeping.
    const barrier = await established(f);
    const barrierSent = write(barrier.client.socket, bytes);
    // Byte comparison: a deep equal over 64 MiB exhausts the worker heap.
    expect((await barrier.peer.read(bytes.length)).equals(bytes)).toBe(true);
    await barrierSent;
    expect(flushed).toBe(false);
    expect(sender.socket.writableLength).toBeGreaterThan(0);
    receiver.socket.resume();
    expect((await receiver.read(bytes.length)).equals(bytes)).toBe(true);
    await sent;
    sender.socket.end();
    await receiver.ended;
    receiver.socket.end();
    await sender.ended;
    await Promise.all([sender.closed, receiver.closed]);
  });
}

test("a refused TCP connection is 502 with no policy violation", async () => {
  const f = await fixture({
    connect: () => {
      const socket = new Socket();
      queueMicrotask(() =>
        socket.destroy(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })),
      );
      return socket;
    },
  });
  await response(await f.open(), 502);
  expect(f.onDenial).not.toHaveBeenCalled();
  expect(f.dials[0]?.socket.destroyed).toBe(true);
  expect(f.proxy.tunnels()).toEqual([]);
});

test("a stalled dial expires at the default 30-second deadline", async () => {
  const dialStarted = deferred<void>();
  const f = await fixture({
    connect: () => {
      dialStarted.resolve();
      return new Socket();
    },
  });
  const client = await f.open();
  await dialStarted.promise;
  await f.clock.scheduled(30_000);
  f.clock.advance(29_999);
  expect(client.transcript).toHaveLength(0);
  f.clock.advance(1);
  await response(client, [502, 504]);
  expect(f.dials[0]?.socket.destroyed).toBe(true);
  expect(f.onDenial).not.toHaveBeenCalled();
  expect(f.proxy.tunnels()).toEqual([]);
});

test("the establishment deadline includes resolution and does not restart for dialing", async () => {
  const slow = slowResolution();
  const started = deferred<void>();
  const f = await fixture({
    resolve: slow.resolve,
    connect: () => {
      started.resolve();
      return new Socket();
    },
    limits: { establishMs: 100 },
  });
  const client = await f.open();
  await slow.entered.promise;
  await f.clock.scheduled(100);
  f.clock.advance(60);
  slow.result.resolve(answer(PUBLIC));
  await started.promise;
  f.clock.advance(39);
  expect(client.transcript).toHaveLength(0);
  f.clock.advance(1);
  await response(client, [502, 504]);
  expect(f.dials[0]?.socket.destroyed).toBe(true);
  await noTunnels(f.proxy);
});

test("a resolution timeout releases the client and ignores a late DNS answer", async () => {
  const slow = slowResolution();
  const f = await fixture({ resolve: slow.resolve, limits: { establishMs: 100 } });
  const client = await f.open();
  await slow.entered.promise;
  await f.clock.scheduled(100);
  f.clock.advance(100);
  await response(client, [502, 504]);
  slow.result.resolve(answer(PUBLIC));
  await turn();
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.onDenial).not.toHaveBeenCalled();
  await noTunnels(f.proxy);
});

test("an upstream reset after 200 closes without injecting another HTTP response", async () => {
  const f = await fixture();
  const { client, peer } = await established(f);
  await write(peer.socket, "opaque payload");
  expect((await client.read(14)).toString()).toBe("opaque payload");
  peer.socket.resetAndDestroy();
  expect(await client.rest()).toHaveLength(0);
  await client.finish();
  await peer.closed;
  expect(f.dials[0]?.socket.destroyed).toBe(true);
  await noTunnels(f.proxy);
  expect(f.onDenial).not.toHaveBeenCalled();
});

test("a client reset during upstream writes closes both sides", async () => {
  const f = await fixture();
  const { client, peer } = await established(f);
  const sending = write(peer.socket, Buffer.alloc(8 * 1024 * 1024)).catch(() => {});
  client.socket.resetAndDestroy();
  await client.closed;
  await peer.finish();
  await sending;
  expect(f.dials[0]?.socket.destroyed).toBe(true);
  await noTunnels(f.proxy);
});

test("an upstream write failure closes the client, not just the failing socket", async () => {
  const f = await fixture();
  const { client, peer } = await established(f);
  const upstream = f.dials[0]!.socket;
  // Deterministic EPIPE at the injected transport boundary, not proxy implementation internals.
  upstream.destroy(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  await Promise.all([client.finish(), peer.finish()]);
  await noTunnels(f.proxy);
  expect(f.onDenial).not.toHaveBeenCalled();
});

test("the default idle deadline is ten minutes and releases both sockets", async () => {
  const f = await fixture();
  const { client, peer } = await established(f);
  await f.clock.scheduled(600_000);
  f.clock.advance(599_999);
  expect(f.proxy.tunnels()).toHaveLength(1);
  f.clock.advance(1);
  await Promise.all([client.finish(), peer.finish()]);
  expect(f.dials[0]?.socket.destroyed).toBe(true);
  await noTunnels(f.proxy);
});

test.each(["client", "upstream"])("bytes from %s reset the idle deadline", async (direction) => {
  const f = await fixture({ limits: { idleMs: 100 } });
  const { client, peer } = await established(f);
  await f.clock.scheduled(100);
  f.clock.advance(60);
  const from = direction === "client" ? client : peer;
  const to = direction === "client" ? peer : client;
  await write(from.socket, "activity");
  expect((await to.read(8)).toString()).toBe("activity");
  f.clock.advance(40);
  expect(f.proxy.tunnels()).toHaveLength(1);
  f.clock.advance(59);
  expect(f.proxy.tunnels()).toHaveLength(1);
  f.clock.advance(1);
  await Promise.all([client.finish(), peer.finish()]);
  await noTunnels(f.proxy);
});

test("revoking a token during resolution prevents late establishment", async () => {
  const slow = slowResolution();
  const f = await fixture({ resolve: slow.resolve });
  const client = await f.open();
  await slow.entered.promise;
  f.proxy.revoke(f.token);
  slow.result.resolve(answer(PUBLIC));
  await client.finish();
  expect(client.transcript.toString()).not.toMatch(/HTTP\/1\.[01] 200/);
  expect(f.connect).not.toHaveBeenCalled();
  await noTunnels(f.proxy);
});

test("proxy close releases established tunnels and its listening port", async () => {
  const f = await fixture();
  const { client, peer } = await established(f);
  await f.close();
  await Promise.all([client.finish(), peer.finish()]);
  expect(f.proxy.tunnels()).toEqual([]);
  const retry = createConnection({ host: "127.0.0.1", port: f.port });
  const closed = deferred<void>();
  retry.once("close", () => closed.resolve());
  const [error] = await once(retry, "error");
  expect((error as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
  await closed.promise;
});

test("the default incomplete-header deadline is ten seconds", async () => {
  const clock = new Clock();
  const durations: number[] = [];
  const accepted = deferred<void>();
  const f = await fixture({
    timers: {
      setTimeout: (fn, ms) => {
        durations.push(ms);
        accepted.resolve();
        return clock.timers.setTimeout(fn, ms);
      },
      clearTimeout: clock.timers.clearTimeout,
    },
  });
  const client = await f.client();
  await accepted.promise;
  expect(durations).toEqual([10_000]);
  clock.advance(10_000);
  await response(client, 400);
  expect(f.resolve).not.toHaveBeenCalled();
});

test("an incomplete CONNECT closes on the configured header deadline without dialing", async () => {
  const clock = new Clock();
  const durations: number[] = [];
  const f = await fixture({
    limits: { headerMs: 17, responseCloseMs: 3 },
    timers: {
      setTimeout: (fn, ms) => {
        durations.push(ms);
        return clock.timers.setTimeout(fn, ms);
      },
      clearTimeout: clock.timers.clearTimeout,
    },
  });
  const client = await f.client();
  await write(client.socket, "CONNECT example.com:443 HTTP/1.1\r\n");
  const barrier = await f.client();
  await write(barrier.socket, request("/", auth(f.token), [], "GET"));
  await response(barrier, 403, true);
  expect(durations).toContain(17);
  clock.advance(17);
  await response(client, 400);
  expect(durations).toContain(3);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
});
