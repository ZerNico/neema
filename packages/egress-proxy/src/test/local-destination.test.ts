import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { allow, CONTEXT, fixture, response, write } from "./helpers.ts";

const AGENT = "ssh-agent.invalid";

/** A stand-in for a service only the host can reach, answering each request once. */
async function service() {
  const server = createServer((socket) => socket.once("data", () => socket.write("agent-reply")));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    connector: () => createConnection({ host: "127.0.0.1", port, allowHalfOpen: true }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("serves an allowed local destination without resolving or dialling it", async () => {
  const agent = await service();
  const local = vi.fn((_context, host: string) => (host === AGENT ? agent.connector : undefined));
  const f = await fixture({
    decide: (_context, host) =>
      host === AGENT ? allow("capability:ssh-agent") : { allowed: false, reason: "No grant" },
    local,
  });
  const client = await f.open(`${AGENT}:1`);
  expect((await client.head()).status).toBe(200);
  await write(client.socket, "list identities");
  expect((await client.read(11)).toString()).toBe("agent-reply");
  client.socket.destroy();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
  expect(local).toHaveBeenCalledWith(CONTEXT, AGENT, 1, true);
  await agent.close();
});

test("never asks for a local destination that decide refused", async () => {
  const local = vi.fn(() => undefined);
  const f = await fixture({
    decide: () => ({ allowed: false, reason: "Not allowed in this chat" }),
    local,
  });
  await response(await f.open(`${AGENT}:1`), 403, true);
  expect(local).not.toHaveBeenCalled();
});

test("answers 502 when the local service cannot be reached", async () => {
  const f = await fixture({
    decide: () => allow("capability:ssh-agent"),
    local: () => () => {
      const socket = createConnection({ host: "127.0.0.1", port: 1 });
      return socket;
    },
  });
  await response(await f.open(`${AGENT}:1`), 502);
});

test("regranting closes a local tunnel whose grant is gone", async () => {
  let granted = true;
  const held = createServer(() => {});
  held.listen(0, "127.0.0.1");
  await once(held, "listening");
  const address = held.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const sockets: Socket[] = [];
  held.on("connection", (socket) => sockets.push(socket));
  const f = await fixture({
    decide: () => (granted ? allow("capability:ssh-agent") : { allowed: false, reason: "Revoked" }),
    local: () => () => createConnection({ host: "127.0.0.1", port, allowHalfOpen: true }),
  });
  const client = await f.open(`${AGENT}:1`);
  expect((await client.head()).status).toBe(200);
  expect(f.proxy.tunnels()).toHaveLength(1);
  granted = false;
  f.proxy.regrant("capability:ssh-agent");
  await client.finish();
  expect(f.proxy.tunnels()).toEqual([]);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => held.close(() => resolve()));
});
