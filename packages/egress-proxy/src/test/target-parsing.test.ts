import { expect, test } from "vitest";
import {
  allow,
  auth,
  CONTEXT,
  established,
  fixture,
  PUBLIC,
  request,
  response,
  write,
} from "./helpers.ts";

const badTargets = [
  "example.com",
  ":443",
  "example.com:",
  "example.com:0",
  "example.com:65536",
  "example.com:00443",
  "example.com:+443",
  "example.com:-1",
  "example.com:443.0",
  "example.com:443junk",
  "example.com: 443",
  "2001:db8::1:443",
  "[2001:db8::1:443",
  "[example.com]:443",
  "[1.2.3.4]:443",
  "https://example.com:443/",
];
for (const target of badTargets) {
  test(`malformed target ${JSON.stringify(target)} is 400`, async () => {
    const f = await fixture({ decide: () => allow() });
    await response(await f.open(target), 400);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.onDenial).not.toHaveBeenCalled();
    expect(f.proxy.tunnels()).toEqual([]);
  });
}

test("an exact authority establishes and dials its checked address and port", async () => {
  const f = await fixture();
  await established(f);
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith("example.com", expect.any(AbortSignal));
  expect(f.connect).toHaveBeenCalledExactlyOnceWith(PUBLIC, 443, 4);
});

test.each([1, 65535])("boundary port %i is accepted without normalization", async (port) => {
  const f = await fixture({ decide: () => allow() });
  await established(f, `example.com:${port}`);
  expect(f.connect).toHaveBeenCalledWith(PUBLIC, port, 4);
});

test.each(["POST", "HEAD", "OPTIONS", "TRACE"])("%s is never forwarded", async (method) => {
  const f = await fixture({ decide: () => allow() });
  const client = await f.client();
  await write(client.socket, request("http://example.com/", auth(f.token), [], method));
  const result = await response(client, 403, true);
  // HEAD has no response body by HTTP convention.
  if (method !== "HEAD") expect(result.body).toMatch(/HTTP|CONNECT/i);
  expect(f.connect).not.toHaveBeenCalled();
});

test.each(["FROB", "frob", "F!#$%&'*+-.^_`|~09"])(
  "extension method %s receives a marked policy denial",
  async (method) => {
    const f = await fixture();
    const client = await f.client();
    await write(client.socket, request("/", auth(f.token), [], method));
    await response(client, 403, true);
    expect(f.onDenial).toHaveBeenCalledTimes(1);
    expect(f.connect).not.toHaveBeenCalled();
  },
);

const plainTargets: Array<[string, string, number]> = [
  ["http://Example.COM.:8080/path", "example.com", 8080],
  ["http://example.com/", "example.com", 80],
  ["HTTP://user:secret@example.com:80/x?q=1", "example.com", 80],
  ["http://[2001:DB8::1]:8443/", "2001:db8::1", 8443],
  ["http://0x7f.1/", "127.0.0.1", 80],
  ["/path", "", 0],
  ["https://example.com/", "", 0],
  ["http:example.com/", "", 0],
  ["http://-bad-.example/", "", 0],
  ["http://example.com:0/", "", 0],
  ["example.com:443", "", 0],
];
test.each(plainTargets)(
  "plain-HTTP target %s reports host %j port %i and is never forwarded",
  async (target, host, port) => {
    const f = await fixture({ decide: () => allow() });
    const client = await f.client();
    await write(client.socket, request(target, auth(f.token), [], "GET"));
    const result = await response(client, 403, true);
    expect(result.body).toMatch(/plain HTTP/i);
    expect(f.denials).toEqual([
      {
        context: CONTEXT,
        host,
        port,
        reason: "Plain HTTP is not supported. Use CONNECT.",
        // No grant could make plain HTTP work.
        lift: null,
      },
    ]);
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  },
);
