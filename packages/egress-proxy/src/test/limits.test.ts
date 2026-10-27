import { expect, test } from "vitest";
import {
  answer,
  auth,
  Clock,
  CONTEXT,
  deferred,
  established,
  fixture,
  noTunnels,
  PUBLIC,
  request,
  response,
  write,
} from "./helpers.ts";

for (const kind of ["one write", "multiple writes"] as const) {
  test(`the early per-connection cap counts ${kind}`, async () => {
    const started = deferred<void>();
    const result = deferred<ReturnType<typeof answer>>();
    const f = await fixture({
      limits: { earlyBytes: 16, earlyBytesTotal: 128 },
      resolve: () => {
        started.resolve();
        return result.promise;
      },
    });
    const client = await f.open(
      "example.com:443",
      f.token,
      Buffer.alloc(kind === "one write" ? 17 : 8, 0x41),
    );
    if (kind === "multiple writes") {
      await started.promise;
      await write(client.socket, Buffer.alloc(9, 0x42));
    }
    await client.finish();
    result.resolve(answer(PUBLIC));
    await noTunnels(f.proxy);
    expect(f.connect).not.toHaveBeenCalled();
    expect(client.transcript.toString()).not.toMatch(/HTTP\/1\.[01] 200/);
  });
}

test("the default early cap refuses more than 64 KiB", async () => {
  const result = deferred<ReturnType<typeof answer>>();
  const f = await fixture({ resolve: () => result.promise });
  const client = await f.open("example.com:443", f.token, Buffer.alloc(64 * 1024 + 1));
  await client.finish();
  result.resolve(answer(PUBLIC));
  await noTunnels(f.proxy);
  expect(f.connect).not.toHaveBeenCalled();
});

test("exactly the early cap is admitted and accounting is released on establishment", async () => {
  const f = await fixture({ limits: { earlyBytes: 8, earlyBytesTotal: 8 } });
  for (let i = 0; i < 2; i++) {
    const client = await f.open("example.com:443", f.token, Buffer.from("12345678"));
    expect((await client.head()).status).toBe(200);
    const peer = await f.peer();
    expect((await peer.read(8)).toString()).toBe("12345678");
  }
  expect(f.proxy.tunnels()).toHaveLength(2);
});

test("the aggregate early cap closes the newest client, not the existing one", async () => {
  const pending: Array<ReturnType<typeof deferred<ReturnType<typeof answer>>>> = [];
  const firstStarted = deferred<void>();
  const f = await fixture({
    limits: { earlyBytes: 8, earlyBytesTotal: 12 },
    resolve: () => {
      const result = deferred<ReturnType<typeof answer>>();
      pending.push(result);
      firstStarted.resolve();
      return result.promise;
    },
  });
  const first = await f.open("example.com:443", f.token, Buffer.from("12345678"));
  await firstStarted.promise;
  const newest = await f.open("example.com:443", f.token, Buffer.from("abcde"));
  await newest.finish();
  expect(newest.transcript.toString()).not.toMatch(/HTTP\/1\.[01] 200/);
  for (const result of pending) result.resolve(answer(PUBLIC));
  expect((await first.head()).status).toBe(200);
  const peer = await f.peer();
  expect((await peer.read(8)).toString()).toBe("12345678");
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.proxy.tunnels()).toHaveLength(1);
});

test("abandonment releases aggregate early-byte reservations", async () => {
  const firstStarted = deferred<void>();
  const firstResult = deferred<ReturnType<typeof answer>>();
  let calls = 0;
  const f = await fixture({
    limits: { earlyBytes: 8, earlyBytesTotal: 8 },
    resolve: () => {
      if (++calls === 1) {
        firstStarted.resolve();
        return firstResult.promise;
      }
      return Promise.resolve(answer(PUBLIC));
    },
  });
  const abandoned = await f.open("example.com:443", f.token, Buffer.from("12345678"));
  await firstStarted.promise;
  abandoned.socket.end();
  await abandoned.closed;
  firstResult.resolve(answer(PUBLIC));
  const next = await f.open("example.com:443", f.token, Buffer.from("abcdefgh"));
  expect((await next.head()).status).toBe(200);
  expect((await (await f.peer()).read(8)).toString()).toBe("abcdefgh");
  expect(f.connect).toHaveBeenCalledTimes(1);
});

test("the default 65th tunnel is a limit denial and does not disturb the first 64", async () => {
  const f = await fixture();
  for (let i = 0; i < 64; i++) await established(f);
  expect(f.proxy.tunnels()).toHaveLength(64);
  const denied = await response(await f.open(), 403, true);
  expect(denied.body).toMatch(/limit|maximum|too many/i);
  expect(f.connect).toHaveBeenCalledTimes(64);
  expect(f.proxy.tunnels()).toHaveLength(64);
  expect(f.onDenial).toHaveBeenCalledTimes(1);
});

test("a shrunk per-token cap is isolated by token and released on closure", async () => {
  const f = await fixture({ limits: { tunnelsPerToken: 1, tunnelsTotal: 4 } });
  const b = await f.proxy.issue({ ...CONTEXT, chat: "chat-c" });
  const first = await established(f);
  await response(await f.open(), 403, true);
  await established(f, "example.com:443", b.token);
  first.client.socket.end();
  first.peer.socket.end();
  await Promise.all([first.client.closed, first.peer.closed]);
  const replacement = await established(f);
  await write(replacement.client.socket, "replacement");
  expect((await replacement.peer.read(11)).toString()).toBe("replacement");
});

test("the global cap denies a different token then reclaims revoked capacity", async () => {
  const f = await fixture({ limits: { tunnelsPerToken: 2, tunnelsTotal: 1 } });
  const b = await f.proxy.issue({ ...CONTEXT, chat: "chat-b" });
  const first = await established(f);
  const denied = await response(await f.open("example.com:443", b.token), 403, true);
  expect(denied.body).toMatch(/limit|maximum|too many/i);
  expect(f.connect).toHaveBeenCalledTimes(1);
  f.proxy.revoke(f.token);
  await Promise.all([first.client.finish(), first.peer.finish()]);
  await established(f, "example.com:443", b.token);
});

test("concurrent establishments cannot oversubscribe the global cap", async () => {
  const f = await fixture({ limits: { tunnelsTotal: 1, tunnelsPerToken: 1 } });
  const b = await f.proxy.issue({ ...CONTEXT, chat: "chat-b" });
  const clients = await Promise.all([f.open(), f.open("example.com:443", b.token)]);
  const heads = await Promise.all(clients.map((client) => client.head()));
  expect(heads.map((head) => head.status).toSorted()).toEqual([200, 403]);
  expect(f.proxy.tunnels()).toHaveLength(1);
  for (let i = 0; i < clients.length; i++) {
    if (heads[i]?.status === 403) {
      expect(heads[i]?.headers["x-egress-denied"]).toBe("1");
      await clients[i]!.finish();
    }
  }
});

test("the pre-tunnel cap bounds accepted sockets and header timers", async () => {
  const clock = new Clock();
  const registered: number[] = [];
  const f = await fixture({
    limits: { connectionsTotal: 2 },
    timers: {
      setTimeout: (fn, ms) => {
        registered.push(ms);
        return clock.timers.setTimeout(fn, ms);
      },
      clearTimeout: clock.timers.clearTimeout,
    },
  });
  const first = await f.client();
  const second = await f.client();
  const extra = await f.client();
  // A request on the first accepted socket is an I/O barrier, not a timer wait.
  await write(first.socket, request("example.com:443", auth(f.token)));
  expect((await first.head()).status).toBe(200);
  expect(registered.filter((ms) => ms === 10_000)).toHaveLength(2); // Two headers.
  expect(registered.filter((ms) => ms === 30_000)).toHaveLength(1); // One establishment.
  await extra.finish();
  expect(extra.transcript.length).toBe(0);
  expect(second.socket.destroyed).toBe(false);
  await write(second.socket, request("example.com:443", auth(f.token)));
  expect((await second.head()).status).toBe(200);
  const replacement = await f.client();
  await write(replacement.socket, request("example.com:443", auth(f.token)));
  expect((await replacement.head()).status).toBe(200);
});

test("a single pre-tunnel slot survives three cycles of 407, 400, 403 and 502", async () => {
  const f = await fixture({
    limits: { connectionsTotal: 1 },
    resolve: async () => {
      throw new Error("resolver failure");
    },
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const [target, authorized, status] of [
      ["example.com:443", false, 407],
      ["example.com", true, 400],
      ["denied.example:443", true, 403],
      ["example.com:443", true, 502],
    ] as const) {
      const client = await f.client();
      await write(client.socket, request(target, authorized ? auth(f.token) : undefined));
      await response(client, status, status === 403);
    }
  }
  expect(f.resolve).toHaveBeenCalledTimes(3);
  expect(f.onDenial).toHaveBeenCalledTimes(3);
  expect(f.connect).not.toHaveBeenCalled();
});

for (const scope of ["per token", "global"] as const) {
  test(`abandoned unresolved DNS retains the ${scope} budget`, async () => {
    const started = deferred<void>();
    const never = deferred<ReturnType<typeof answer>>();
    const f = await fixture({
      limits: { tunnelsPerToken: 1, tunnelsTotal: scope === "global" ? 1 : 4 },
      resolve: () => {
        started.resolve();
        return never.promise;
      },
    });
    const abandoned = await f.open();
    await started.promise;
    abandoned.socket.end();
    await abandoned.closed;
    const token =
      scope === "global" ? (await f.proxy.issue({ ...CONTEXT, chat: "other" })).token : f.token;
    for (let i = 0; i < 3; i++) {
      const client = await f.open("example.com:443", token);
      // This response proves the request was processed before the resolver count is checked.
      const barrier = await f.client();
      await write(barrier.socket, request("/", auth(f.token), [], "GET"));
      await response(barrier, 403, true);
      expect(f.resolve).toHaveBeenCalledTimes(1);
      expect((await response(client, 403, true)).body).toMatch(/resolution.*limit/i);
    }
    expect(f.connect).not.toHaveBeenCalled();
  });
}

test("settling abandoned DNS releases explicit resolution budgets", async () => {
  const started = deferred<void>();
  const result = deferred<ReturnType<typeof answer>>();
  const f = await fixture({
    limits: { outstandingResolutionsPerToken: 1, outstandingResolutionsTotal: 1 },
    resolve: () => {
      started.resolve();
      return result.promise;
    },
  });
  const abandoned = await f.open();
  await started.promise;
  abandoned.socket.end();
  await abandoned.closed;
  const blocked = await f.open();
  const barrier = await f.client();
  await write(barrier.socket, request("/", auth(f.token), [], "GET"));
  await response(barrier, 403, true);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  await response(blocked, 403, true);
  result.resolve(answer(PUBLIC));
  await result.promise;
  await established(f);
  expect(f.resolve).toHaveBeenCalledTimes(2);
});

test("failed resolutions release a one-slot budget before the next request", async () => {
  let calls = 0;
  const f = await fixture({
    limits: { outstandingResolutionsPerToken: 1, outstandingResolutionsTotal: 1 },
    resolve: async () => {
      if (++calls <= 3) throw new Error("resolver failure");
      return answer(PUBLIC);
    },
  });
  for (let i = 0; i < 3; i++) await response(await f.open(), 502);
  await established(f);
  expect(f.resolve).toHaveBeenCalledTimes(4);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.onDenial).not.toHaveBeenCalled();
});
