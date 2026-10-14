import { createConnection } from "node:net";
import { once } from "node:events";
import { expect, test } from "vitest";
import { CONTEXT, fixture, request, response, turn, Wire, write } from "./helpers.ts";

const other = { ...CONTEXT, command: "other-command" };

async function dial(proxyUrl: string) {
  const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(proxyUrl).port) });
  const wire = new Wire(socket);
  await once(socket, "connect");
  return wire;
}

test("a command's own port needs no credentials and serves only that command", async () => {
  const f = await fixture();
  const { proxyUrl } = await f.proxy.issuePort(other);
  expect(new URL(proxyUrl).username).toBe("");
  expect(new URL(proxyUrl).port).not.toBe(String(f.port));
  const client = await dial(proxyUrl);
  await write(client.socket, request("example.com:443"));
  expect((await client.head()).status).toBe(200);
  await f.peer();
  expect(f.decide).toHaveBeenCalledWith(other, "example.com", 443);
});

test("another command's credentials do not change whose port it is", async () => {
  const f = await fixture();
  const { proxyUrl } = await f.proxy.issuePort(other);
  const client = await dial(proxyUrl);
  await write(
    client.socket,
    request("example.com:443", `Basic ${Buffer.from(`cmd:${f.token}`).toString("base64")}`),
  );
  expect((await client.head()).status).toBe(200);
  await f.peer();
  expect(f.decide).toHaveBeenCalledWith(other, "example.com", 443);
});

test("the shared port still asks for a token", async () => {
  const f = await fixture();
  await f.proxy.issuePort(other);
  const client = await f.client();
  await write(client.socket, request("example.com:443"));
  await response(client, 407);
});

test("revoking the command closes its port and its tunnels", async () => {
  const f = await fixture();
  const { token, proxyUrl } = await f.proxy.issuePort(other);
  const client = await dial(proxyUrl);
  await write(client.socket, request("example.com:443"));
  expect((await client.head()).status).toBe(200);
  await f.peer();
  f.proxy.revoke(token);
  await client.finish();
  expect(f.proxy.tunnels()).toEqual([]);
  const refused = createConnection({ host: "127.0.0.1", port: Number(new URL(proxyUrl).port) });
  const [error] = (await once(refused, "error")) as [NodeJS.ErrnoException];
  expect(error.code).toBe("ECONNREFUSED");
});

test("closing the proxy closes every command's port", async () => {
  const f = await fixture();
  const { proxyUrl } = await f.proxy.issuePort(other);
  await f.close();
  await turn();
  const refused = createConnection({ host: "127.0.0.1", port: Number(new URL(proxyUrl).port) });
  const [error] = (await once(refused, "error")) as [NodeJS.ErrnoException];
  expect(error.code).toBe("ECONNREFUSED");
  await expect(f.proxy.issuePort(other)).rejects.toThrow("closed");
});

test("a local destination on a command's own port knows whether the token came along", async () => {
  const seen: boolean[] = [];
  const f = await fixture({
    decide: () => ({ allowed: true, grantId: "agent" }),
    local: (_context, _host, _port, proven) => {
      seen.push(proven);
      return proven ? undefined : null;
    },
  });
  const { token, proxyUrl } = await f.proxy.issuePort(other);
  // Anyone on this machine can reach the port; without the token the agent stays shut.
  const stranger = await dial(proxyUrl);
  await write(stranger.socket, request("ssh-agent.invalid:1"));
  await response(stranger, 403, true);
  // Refused, but not counted against the command whose port it is.
  expect(f.onDenial).not.toHaveBeenCalled();
  const bridge = await dial(proxyUrl);
  await write(
    bridge.socket,
    request("example.com:443", `Basic ${Buffer.from(`cmd:${token}`).toString("base64")}`),
  );
  expect((await bridge.head()).status).toBe(200);
  await f.peer();
  // The stranger's request was judged unproven, the bridge's proven.
  expect(seen[0]).toBe(false);
  expect(seen.at(-1)).toBe(true);
});

test("a stranger asking a command's port for a local destination its chat refused is not counted", async () => {
  const f = await fixture({
    decide: (_context, host) =>
      host === "ssh-agent.invalid"
        ? { allowed: false, reason: "The chat has not allowed the agent" }
        : { allowed: true, grantId: "g" },
    local: (_context, host, _port, proven) =>
      host === "ssh-agent.invalid" ? (proven ? undefined : null) : undefined,
  });
  const { proxyUrl } = await f.proxy.issuePort(other);
  const stranger = await dial(proxyUrl);
  await write(stranger.socket, request("ssh-agent.invalid:1"));
  await response(stranger, 403, true);
  // Nor by plain HTTP, which is refused on another path.
  const plain = await dial(proxyUrl);
  await write(
    plain.socket,
    "GET http://ssh-agent.invalid:1/ HTTP/1.1\r\nHost: ssh-agent.invalid:1\r\n\r\n",
  );
  await response(plain, 403, true);
  expect(f.onDenial).not.toHaveBeenCalled();
});
