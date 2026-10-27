import { Socket } from "node:net";
import { expect, test, vi } from "vitest";
import type { GrantDecision } from "../index.ts";
import {
  allow,
  answer,
  CONTEXT,
  deferred,
  established,
  fixture,
  noTunnels,
  PUBLIC,
  PUBLIC6,
  response,
  turn,
  write,
  type Fixture,
} from "./helpers.ts";

const B = { server: "server-b", chat: "chat-b" };

test("command revocation closes all its tunnels in one turn, not other commands", async () => {
  const f = await fixture();
  const b = await f.proxy.issue(B);
  const first = await established(f);
  const second = await established(f);
  const other = await established(f, "example.com:443", b.token);
  expect(f.proxy.tunnels()).toHaveLength(3);
  f.proxy.revoke(f.token);
  await turn();
  expect(f.dials.slice(0, 2).every((dial) => dial.socket.destroyed)).toBe(true);
  expect(f.proxy.tunnels()).toEqual([
    { context: B, host: "example.com", port: 443, grantId: "grant-a" },
  ]);
  await Promise.all([
    first.client.finish(),
    second.client.finish(),
    first.peer.finish(),
    second.peer.finish(),
  ]);
  expect(f.dials.slice(0, 2).every((dial) => dial.socket.destroyed)).toBe(true);
  await response(await f.open(), 407);
  await write(other.peer.socket, "still live");
  expect((await other.client.read(10)).toString()).toBe("still live");
});

test.each(["builtin", "always", "chat", "answer"])(
  "removal of the sole %s grant closes its tunnels",
  async (scope) => {
    let present = true;
    const f = await fixture({
      decide: () => (present ? allow(scope) : { allowed: false, reason: "Grant removed" }),
    });
    const tunnel = await established(f);
    present = false;
    f.proxy.regrant(scope);
    await Promise.all([tunnel.client.finish(), tunnel.peer.finish()]);
    await noTunnels(f.proxy);
    expect(f.dials[0]?.socket.destroyed).toBe(true);
  },
);

test("removing a chat grant retains an always-backed tunnel and updates its justification", async () => {
  let chat = true;
  let always = false;
  const f = await fixture({
    decide: () =>
      always
        ? allow("always")
        : chat
          ? allow("chat")
          : { allowed: false, reason: "No grant remains" },
  });
  const tunnel = await established(f);
  expect(f.proxy.tunnels()[0]?.grantId).toBe("chat");
  chat = false;
  always = true;
  f.proxy.regrant("chat");
  expect(f.proxy.tunnels()[0]?.grantId).toBe("always");
  await write(tunnel.peer.socket, "preserved");
  expect((await tunnel.client.read(9)).toString()).toBe("preserved");
  always = false;
  f.proxy.regrant("always");
  await Promise.all([tunnel.client.finish(), tunnel.peer.finish()]);
  await noTunnels(f.proxy);
});

test("a removed grant never over-closes tunnels justified by another grant", async () => {
  let chat = true;
  const f = await fixture({
    decide: (context) =>
      context.chat === B.chat ? allow("always") : chat ? allow("chat") : { allowed: false },
  });
  const b = await f.proxy.issue(B);
  const removed = await established(f);
  const kept = await established(f, "example.com:443", b.token);
  chat = false;
  f.proxy.regrant("chat");
  await Promise.all([removed.client.finish(), removed.peer.finish()]);
  expect(f.proxy.tunnels()).toEqual([
    { context: B, host: "example.com", port: 443, grantId: "always" },
  ]);
  await write(kept.client.socket, "retained");
  expect((await kept.peer.read(8)).toString()).toBe("retained");
});

test("concurrent commands retain their own server/chat/attempt policy", async () => {
  const f = await fixture({
    decide: (context, host) => ({
      allowed:
        (context.chat === CONTEXT.chat && host === "a.example") ||
        (context.chat === B.chat && host === "b.example"),
      grantId: context.chat,
      reason: "Not granted to this chat",
    }),
  });
  const b = await f.proxy.issue(B);
  const [aYes, aNo, bYes, bNo] = await Promise.all([
    f.open("a.example:443"),
    f.open("b.example:443"),
    f.open("b.example:443", b.token),
    f.open("a.example:443", b.token),
  ]);
  expect((await aYes.head()).status).toBe(200);
  expect((await bYes.head()).status).toBe(200);
  await response(aNo, 403, true);
  await response(bNo, 403, true);
  expect(f.denials).toEqual(
    expect.arrayContaining([
      {
        context: CONTEXT,
        host: "b.example",
        port: 443,
        reason: expect.any(String),
        lift: "grant",
      },
      { context: B, host: "a.example", port: 443, reason: expect.any(String), lift: "grant" },
    ]),
  );
  expect(f.denials).toHaveLength(2);
  expect(f.proxy.tunnels()).toEqual(
    expect.arrayContaining([
      { context: CONTEXT, host: "a.example", port: 443, grantId: CONTEXT.chat },
      { context: B, host: "b.example", port: 443, grantId: B.chat },
    ]),
  );
});

test("bearer token identity wins over the process using it until revocation", async () => {
  const f = await fixture({
    decide: (context) => ({ allowed: context.chat === CONTEXT.chat, grantId: "a-only" }),
  });
  const b = await f.proxy.issue(B);
  await response(await f.open("example.com:443", b.token), 403, true);
  const borrowed = await established(f, "example.com:443", f.token);
  expect(f.proxy.tunnels()[0]?.context).toEqual(CONTEXT);
  f.proxy.revoke(f.token);
  await Promise.all([borrowed.client.finish(), borrowed.peer.finish()]);
  await response(await f.open("example.com:443", f.token), 407);
});

test("an ordinary fallback cannot keep a private-network tunnel alive", async () => {
  let privatePermission = true;
  const f = await fixture({
    decide: () => (privatePermission ? allow("private-chat", true) : allow("ordinary-always")),
    resolve: async () => answer("10.1.2.3"),
  });
  const { client, peer } = await established(f);
  privatePermission = false;
  f.proxy.regrant("private-chat");
  await Promise.all([client.finish(), peer.finish()]);
  await noTunnels(f.proxy);
  expect(f.resolve).toHaveBeenCalledTimes(1);
});

test("regrant of an unrelated entry changes no tunnel", async () => {
  const f = await fixture();
  const { client, peer } = await established(f);
  f.proxy.regrant("unrelated-grant");
  expect(f.proxy.tunnels()).toHaveLength(1);
  await write(peer.socket, "ok");
  expect((await client.read(2)).toString()).toBe("ok");
});

// A decider outside the type system (plain JS, a bad deserialization) can still omit the id.
const missingGrantId: GrantDecision = JSON.parse('{"allowed":true}');

test.each([undefined, "", "   "])(
  "an allow without a nonempty grant id (%j) faults before dialing",
  async (grantId) => {
    const f = await fixture({
      decide: () => (grantId === undefined ? missingGrantId : { allowed: true, grantId }),
    });
    await response(await f.open(), 500);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.onDenial).not.toHaveBeenCalled();
  },
);

test.each([
  ["an empty", ""],
  ["a blank", "   "],
  ["a missing", undefined],
] as const)(
  "regrant replacing an established decision with %s grant id faults and closes the tunnel",
  async (_label, grantId) => {
    let replacement: GrantDecision | undefined;
    const log = vi.fn();
    const f = await fixture({ decide: () => replacement ?? allow(), log });
    const tunnel = await established(f);
    expect(f.proxy.tunnels()).toHaveLength(1);
    replacement = grantId === undefined ? missingGrantId : { allowed: true, grantId };
    f.proxy.regrant("grant-a");
    expect(f.proxy.tunnels()).toEqual([]);
    await Promise.all([tunnel.client.finish(), tunnel.peer.finish()]);
    expect(tunnel.client.transcript.toString("latin1")).toBe(
      "HTTP/1.1 200 Connection Established\r\n\r\n",
    );
    expect(f.onDenial).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("error", "Egress proxy: internal fault");
  },
);

test.each(["resolving", "dialing"] as const)(
  "a regrant denial while %s sends one marked 403",
  async (phase) => {
    const started = deferred<void>();
    const result = deferred<ReturnType<typeof answer>>();
    let allowed = true;
    const f = await fixture({
      decide: () => (allowed ? allow() : { allowed: false, reason: "Grant removed" }),
      resolve: () => {
        if (phase === "resolving") started.resolve();
        return result.promise;
      },
      connect: () => {
        started.resolve();
        return new Socket();
      },
    });
    if (phase === "dialing") result.resolve(answer(PUBLIC));
    const client = await f.open();
    await started.promise;
    allowed = false;
    f.proxy.regrant("grant-a");
    result.resolve(answer(PUBLIC));
    await response(client, 403, true);
    expect(f.onDenial).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(phase === "dialing" ? 1 : 0);
    expect(f.dials.every(({ socket }) => socket.destroyed)).toBe(true);
  },
);

for (const order of ["network then policy", "policy then network"] as const) {
  test(`narrowed private permission prefers a denial with ${order} candidates`, async () => {
    const started = deferred<void>();
    const first = new Socket();
    let privateNetwork = true;
    let calls = 0;
    const f = await fixture({
      decide: () => allow(privateNetwork ? "private" : "ordinary", privateNetwork),
      resolve: async () =>
        order === "network then policy"
          ? [...answer(PUBLIC), ...answer("10.1.2.3")]
          : [...answer(PUBLIC), ...answer("10.1.2.3"), ...answer("93.184.216.35")],
      connect: () => {
        if (++calls === 1) {
          started.resolve();
          return first;
        }
        throw new Error("network refused");
      },
    });
    const client = await f.open();
    await started.promise;
    privateNetwork = false;
    f.proxy.regrant("private");
    first.destroy(new Error("network refused"));
    expect((await response(client, 403, true)).body).toContain("private network");
    expect(f.onDenial).toHaveBeenCalledTimes(1);
    expect(f.onDenial.mock.calls[0]?.[0]).toMatchObject({
      reason: expect.stringContaining("private network"),
      lift: "private-network",
    });
    expect(f.connect).toHaveBeenCalledTimes(order === "network then policy" ? 1 : 2);
    expect(f.dials.some(({ address }) => address === "10.1.2.3")).toBe(false);
  });
}

test("private permission removed during a public IPv6 dial cannot admit a private fallback", async () => {
  const started = deferred<Socket>();
  let privatePermission = true;
  const f = await fixture({
    decide: () => allow(privatePermission ? "private" : "ordinary", privatePermission),
    resolve: async () => [
      { address: PUBLIC6, family: 6 },
      { address: "10.1.2.3", family: 4 },
    ],
    connect: () => {
      const socket = new Socket();
      started.resolve(socket);
      return socket;
    },
  });
  const client = await f.open();
  const socket = await started.promise;
  privatePermission = false;
  f.proxy.regrant("private");
  socket.destroy(new Error("Injected dial failure"));
  await response(client, 403, true);
  expect(f.onDenial).toHaveBeenCalledTimes(1);
  expect(f.onDenial.mock.calls[0]?.[0]).toMatchObject({
    reason: expect.stringContaining("private network"),
    lift: "private-network",
  });
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.resolve).toHaveBeenCalledTimes(1);
});

test("a private-network grant lifts a refusal when any address was private", async () => {
  for (const [addresses, lift] of [
    [["10.1.2.3", "192.168.1.9"], "private-network"],
    [["10.1.2.3", "127.0.0.1"], "private-network"],
    [["127.0.0.1", "169.254.1.1"], null],
  ] as const) {
    const f = await fixture({
      decide: () => allow("ordinary", false),
      resolve: async () => addresses.map((address) => ({ address, family: 4 as const })),
    });
    const client = await f.open();
    await response(client, 403, true);
    expect(f.onDenial.mock.calls[0]?.[0].lift).toBe(lift);
  }
});

test("a regrant refusing the private candidate being dialed reports one denial", async () => {
  const started = deferred<void>();
  let privateNetwork = true;
  const f = await fixture({
    decide: () => allow(privateNetwork ? "private" : "ordinary", privateNetwork),
    resolve: async () => answer("10.1.2.3"),
    connect: () => {
      started.resolve();
      return new Socket();
    },
  });
  const client = await f.open();
  await started.promise;
  privateNetwork = false;
  f.proxy.regrant("private");
  await response(client, 403, true);
  expect(f.onDenial).toHaveBeenCalledTimes(1);
});

test("revocation inside the policy callback cannot resurrect a connection", async () => {
  let f: Fixture;
  f = await fixture({
    decide: () => {
      f.proxy.revoke(f.token);
      return allow();
    },
  });
  const client = await f.open();
  await client.finish();
  expect(client.transcript.length).toBe(0);
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.proxy.tunnels()).toEqual([]);
});

test("revocation inside the connector closes the socket it returns", async () => {
  let f: Fixture;
  f = await fixture({
    connect: () => {
      f.proxy.revoke(f.token);
      return new Socket();
    },
  });
  const client = await f.open();
  await client.finish();
  expect(client.transcript.length).toBe(0);
  expect(f.dials[0]?.socket.destroyed).toBe(true);
  expect(f.proxy.tunnels()).toEqual([]);
});

test("a grant revoked while the tunnel is still being set up is reported as liftable by a grant", async () => {
  let granted = true;
  const resolving = deferred<void>();
  const lookup = deferred<Array<{ address: string; family: 4 }>>();
  const f = await fixture({
    decide: () => (granted ? allow("chat") : { allowed: false, reason: "Grant removed" }),
    resolve: () => {
      resolving.resolve();
      return lookup.promise;
    },
  });
  const client = await f.open();
  await resolving.promise;
  granted = false;
  f.proxy.regrant("chat");
  await response(client, 403, true);
  // Asking for the grant again would let it through, so the denial must say so.
  expect(f.denials).toEqual([
    { context: CONTEXT, host: "example.com", port: 443, reason: "Grant removed", lift: "grant" },
  ]);
  lookup.resolve([{ address: PUBLIC, family: 4 }]);
});

test("a refused private address still answers when the public one beside it fails", async () => {
  const f = await fixture({
    decide: () => allow("ordinary", false),
    resolve: async () => [
      { address: "10.20.30.40", family: 4 },
      { address: PUBLIC6, family: 6 },
    ],
    connect: () => {
      const socket = new Socket();
      queueMicrotask(() => socket.destroy(new Error("Injected dial failure")));
      return socket;
    },
  });
  const client = await f.open();
  await response(client, 403, true);
  expect(f.onDenial.mock.calls[0]?.[0].lift).toBe("private-network");
});
