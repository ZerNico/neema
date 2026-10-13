import { expect, test } from "vitest";
import { auth, CONTEXT, established, fixture, request, response, write } from "./helpers.ts";

const rejected: Array<[string, (token: string) => string | undefined]> = [
  ["absent authorization", () => undefined],
  ["Bearer is not Basic", (token) => `Bearer ${token}`],
  ["extra Base64 padding", (token) => `${auth(token)}=`],
  ["whitespace inside Base64", (token) => auth(token).slice(0, 10) + " " + auth(token).slice(10)],
  ["non-alphabet Base64 byte", (token) => `${auth(token)}!`],
  ["URL-safe alphabet is not the Basic alphabet", () => "Basic ____"],
  [
    "decoded credentials must be valid UTF-8",
    (token) =>
      `Basic ${Buffer.concat([Buffer.from("cmd:"), Buffer.from([0xc0, 0xaf]), Buffer.from(token)]).toString("base64")}`,
  ],
  ["wrong username", (token) => auth(token, "user")],
  ["fixed username is case sensitive", (token) => auth(token, "CMD")],
  ["two colons", (token) => auth(`${token}:extra`)],
  [
    "unknown token with the minted shape",
    (token) => auth((token[0] === "A" ? "B" : "A") + token.slice(1)),
  ],
  ["too-short token", () => auth("a")],
  ["token has invalid alphabet", (token) => auth("!" + token.slice(1))],
];
for (const [name, authorization] of rejected) {
  test(`${name} is 407 before any policy, DNS or dial`, async () => {
    const f = await fixture();
    const client = await f.client();
    await write(client.socket, request("example.com:443", authorization(f.token)));
    await response(client, 407);
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.onDenial).not.toHaveBeenCalled();
  });
}

for (const ending of ["\n", "\r", "\r\n", " ", " "]) {
  test(`decoded credentials reject a trailing ${JSON.stringify(ending)}`, async () => {
    const f = await fixture();
    const client = await f.client();
    await write(client.socket, request("example.com:443", auth(f.token + ending)));
    await response(client, 407);
    expect(f.decide).not.toHaveBeenCalled();
  });
}

test("a finished command's token is rejected", async () => {
  const f = await fixture();
  f.proxy.revoke(f.token);
  await response(await f.open(), 407);
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});

test("duplicate authorization headers, including mixed header casing, are rejected", async () => {
  const f = await fixture();
  const client = await f.client();
  await write(
    client.socket,
    request("example.com:443", auth(f.token), [`pRoXy-AuThOrIzAtIoN: ${auth(f.token)}`]),
  );
  await response(client, 407);
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});

test("mixed-case scheme, multiple separator spaces and trailing spaces are accepted", async () => {
  const f = await fixture();
  const client = await f.client();
  await write(
    client.socket,
    request("example.com:443", auth(f.token).replace("Basic ", "bAsIc   ") + "   "),
  );
  expect((await client.head()).status).toBe(200);
  expect(f.decide).toHaveBeenCalledWith(CONTEXT, "example.com", 443);
});

test("missing credentials beat a malformed but HTTP-parseable target", async () => {
  const f = await fixture();
  const client = await f.client();
  await write(client.socket, request("not-an-authority"));
  await response(client, 407);
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});

test("issuance produces independent URL-safe tokens with at least 256 encoded bits", async () => {
  const f = await fixture();
  const another = f.proxy.issue({ ...CONTEXT, command: "command-b" });
  for (const issued of [f, another]) {
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(issued.token, "base64url").length).toBeGreaterThanOrEqual(32);
    const url = new URL(issued.proxyUrl);
    expect(url.protocol).toBe("http:");
    expect(url.username).toBe("cmd");
    expect(url.password).toBe(issued.token);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe(String(f.port));
  }
  expect(another.token).not.toBe(f.token);
  await established(f);
  expect(JSON.stringify(f.proxy.tunnels())).not.toContain(f.token);
});
