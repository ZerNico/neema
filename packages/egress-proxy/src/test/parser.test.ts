import { expect, test, vi } from "vitest";
import { RequestParser } from "../parser.ts";
import { answer, auth, deferred, fixture, PUBLIC, request, response, write } from "./helpers.ts";

function craftedHeader(spaces: number) {
  return Buffer.from(`CONNECT example.com:443 HTTP/1.1\r\nX-Fill: a${" ".repeat(spaces)}b\r\n\r\n`);
}

test("byte-fragmented headers copy and search only linear bytes", () => {
  const input = craftedHeader(16_000);
  let copied = 0;
  let searched = 0;
  const concat = Buffer.concat;
  const copy = Buffer.prototype.copy;
  const indexOf = Buffer.prototype.indexOf;
  vi.spyOn(Buffer.prototype, "copy").mockImplementation(function (
    this: Buffer,
    target,
    targetStart,
    sourceStart,
    sourceEnd,
  ) {
    const count = copy.call(this, target, targetStart, sourceStart, sourceEnd);
    copied += count;
    return count;
  });
  vi.spyOn(Buffer, "concat").mockImplementation((list, length) => {
    copied += list.reduce((sum, part) => sum + part.length, 0);
    return concat(list, length);
  });
  vi.spyOn(Buffer.prototype, "indexOf").mockImplementation(function (
    this: Buffer,
    value,
    offset,
    encoding,
  ) {
    if (value === "\r\n\r\n") searched += this.length - (typeof offset === "number" ? offset : 0);
    return indexOf.call(this, value, offset, encoding);
  });
  const parser = new RequestParser();
  let parsed: ReturnType<RequestParser["feed"]>;
  for (let i = 0; i < input.length; i++) parsed = parser.feed(input.subarray(i, i + 1));
  expect(parsed!).toHaveProperty("request");
  expect(copied).toBeLessThanOrEqual(input.length * 2);
  expect(searched).toBeLessThanOrEqual(input.length * 5);
});

test("fragmented headers including a split terminator preserve the exact early payload", async () => {
  const started = deferred<void>();
  const result = deferred<ReturnType<typeof answer>>();
  const f = await fixture({
    resolve: () => {
      started.resolve();
      return result.promise;
    },
  });
  const client = await f.client();
  const head = request("example.com:443", auth(f.token));
  const payload = Buffer.from([0, 1, 13, 10, 255, 42]);
  const parts = [
    head.subarray(0, 9),
    head.subarray(9, -3),
    head.subarray(-3, -1),
    Buffer.concat([head.subarray(-1), payload]),
  ];
  const fed: Buffer[] = [];
  const feed = RequestParser.prototype.feed;
  const waiters: Array<ReturnType<typeof deferred<void>>> = [];
  vi.spyOn(RequestParser.prototype, "feed").mockImplementation(function (
    this: RequestParser,
    chunk,
  ) {
    fed.push(chunk);
    const parsed = feed.call(this, chunk);
    waiters.shift()?.resolve();
    return parsed;
  });
  for (const part of parts) {
    const received = deferred<void>();
    waiters.push(received);
    await write(client.socket, part);
    await received.promise;
  }
  expect(fed).toHaveLength(4);
  await started.promise;
  result.resolve(answer(PUBLIC));
  expect((await client.head()).status).toBe(200);
  expect((await (await f.peer()).read(payload.length)).equals(payload)).toBe(true);
});

for (const location of ["request line", "header value"]) {
  test(`a bare LF at the end of the ${location} is a parser error`, async () => {
    const f = await fixture();
    const client = await f.client();
    const line = `CONNECT example.com:443 HTTP/1.1${location === "request line" ? "\n" : ""}`;
    const header = `Proxy-Authorization: ${auth(f.token)}${location === "header value" ? "\n" : ""}`;
    await write(client.socket, `${line}\r\n${header}\r\n\r\n`);
    await response(client, 400);
    expect(f.decide).not.toHaveBeenCalled();
  });
}

test("an invalid header name returns 400 then closes", async () => {
  const f = await fixture();
  const client = await f.client();
  await write(
    client.socket,
    Buffer.from(
      `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: ${auth(f.token)}\r\nBad Header: x\r\n\r\n`,
    ),
  );
  await response(client, 400);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.onDenial).not.toHaveBeenCalled();
});

test("oversized headers return 431 then close without dialing", async () => {
  const f = await fixture();
  const client = await f.client();
  await write(
    client.socket,
    request("example.com:443", auth(f.token), [`X-Fill: ${"x".repeat(256 * 1024)}`]),
  ).catch(() => {});
  await response(client, 431);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.onDenial).not.toHaveBeenCalled();
});
