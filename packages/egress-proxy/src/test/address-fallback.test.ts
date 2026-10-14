import { createConnection, Socket } from "node:net";
import { expect, test } from "vitest";
import { deferred, fixture, PUBLIC, PUBLIC6 } from "./helpers.ts";

/** A connect attempt that neither connects nor fails, as on a blackholed route. */
const silent = () => new Socket();

test("a silent first address gives way to the next before the deadline", async () => {
  let upstreamPort = 0;
  const firstDialled = deferred<void>();
  const f = await fixture({
    resolve: async () => [
      { address: PUBLIC6, family: 6 as const },
      { address: PUBLIC, family: 4 as const },
    ],
    connect: (address) => {
      if (address !== PUBLIC6)
        return createConnection({ host: "127.0.0.1", port: upstreamPort, allowHalfOpen: true });
      firstDialled.resolve();
      return silent();
    },
  });
  upstreamPort = f.upstreamPort;
  const client = await f.open();
  await firstDialled.promise;
  f.clock.advance(5_000);
  expect((await client.head()).status).toBe(200);
  expect(f.dials.map((dial) => dial.address)).toEqual([PUBLIC6, PUBLIC]);
  await f.peer();
});

test("the last address keeps the whole establishment deadline", async () => {
  const dialled = deferred<Socket>();
  const f = await fixture({
    connect: () => {
      const socket = silent();
      dialled.resolve(socket);
      return socket;
    },
  });
  const client = await f.open();
  const socket = await dialled.promise;
  f.clock.advance(5_000);
  // Cut off at the per-address limit, the attempt would already be gone.
  expect(socket.destroyed).toBe(false);
  expect(f.dials).toHaveLength(1);
  f.clock.advance(25_000);
  expect((await client.head()).status).toBe(502);
  expect(f.dials).toHaveLength(1);
});

test("a refused private address still answers when the public one beside it stays silent", async () => {
  const dialled = deferred<void>();
  const f = await fixture({
    decide: () => ({ allowed: true, grantId: "ordinary" }),
    resolve: async () => [
      { address: "10.20.30.40", family: 4 as const },
      { address: PUBLIC6, family: 6 as const },
    ],
    connect: () => {
      dialled.resolve();
      return silent();
    },
  });
  const client = await f.open();
  await dialled.promise;
  f.clock.advance(30_000);
  expect((await client.head()).status).toBe(403);
  expect(f.onDenial.mock.calls[0]?.[0].reason).toContain("private network");
});
