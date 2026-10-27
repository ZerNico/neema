import { createSocket } from "node:dgram";
import { expect, test } from "vitest";
import { answerQuery, parseQuery } from "../dns.ts";
import { isPlaceholder, NameTable } from "../names.ts";
import { allow, auth, established, fixture, request, response, write } from "./helpers.ts";

/** A standard query for one name, as a stub resolver sends it. */
function query(name: string, type = 1, id = 0x1234) {
  const labels = name
    .split(".")
    .filter(Boolean)
    .map((label) => {
      const bytes = Buffer.from(label, "latin1");
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header[2] = 0x01;
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}

function decode(answer: Buffer) {
  const rcode = answer[3]! & 0x0f;
  const count = answer.readUInt16BE(6);
  const address = count ? [...answer.subarray(answer.length - 4)].join(".") : undefined;
  return { id: answer.readUInt16BE(0), rcode, count, address, recursion: answer[2]! & 0x01 };
}

async function lookUp(dns: string, name: string, type = 1) {
  const [host, port] = dns.split(":");
  const socket = createSocket("udp4");
  try {
    const reply = new Promise<Buffer>((resolve) => socket.once("message", resolve));
    socket.send(query(name, type), Number(port), host);
    return decode(await reply);
  } finally {
    socket.close();
  }
}

test("each name gets its own stable placeholder from the benchmarking range", () => {
  const names = new NameTable(10);
  const first = names.address("example.com");
  expect(first).toBe("198.18.0.1");
  expect(names.address("example.com")).toBe(first);
  expect(names.address("pypi.org")).toBe("198.18.0.2");
  expect(names.name("198.18.0.2")).toBe("pypi.org");
  expect(names.name("198.18.0.9")).toBeUndefined();
  for (const address of ["198.18.0.1", "198.19.255.254", "198.18.0.0"])
    expect(isPlaceholder(address)).toBe(true);
  for (const address of ["198.17.255.255", "198.20.0.0", "93.184.216.34", "not-an-ip"])
    expect(isPlaceholder(address)).toBe(false);
});

test("a full table hands out no more placeholders", () => {
  const names = new NameTable(2);
  expect(names.address("a.test")).toBeDefined();
  expect(names.address("b.test")).toBeDefined();
  expect(names.address("c.test")).toBeUndefined();
  expect(names.address("a.test")).toBeDefined();
});

test("A answers the placeholder, AAAA and other types answer empty, nothing is resolved", () => {
  const names = new NameTable(10);
  const a = decode(answerQuery(query("Example.COM."), names)!);
  expect(a).toMatchObject({ id: 0x1234, rcode: 0, count: 1, address: "198.18.0.1", recursion: 1 });
  expect(decode(answerQuery(query("example.com", 28), names)!)).toMatchObject({
    rcode: 0,
    count: 0,
  });
  expect(decode(answerQuery(query("example.com", 16), names)!)).toMatchObject({
    rcode: 0,
    count: 0,
  });
  // The AAAA and TXT lookups assigned nothing new.
  expect(names.address("next.test")).toBe("198.18.0.2");
});

test("names that are no host, and a full table, are answered with errors", () => {
  const names = new NameTable(1);
  expect(decode(answerQuery(query("bad_name!.test"), names)!).rcode).toBe(3);
  expect(decode(answerQuery(query("1.2.3.4"), names)!).rcode).toBe(3);
  names.address("taken.test");
  expect(decode(answerQuery(query("other.test"), names)!).rcode).toBe(2);
});

test("malformed queries get FORMERR, other opcodes NOTIMP, responses no answer", () => {
  const names = new NameTable(10);
  expect(answerQuery(Buffer.alloc(5), names)).toBeUndefined();
  const answered = query("example.com");
  answered[2] = 0x81;
  expect(answerQuery(answered, names)).toBeUndefined();
  const compressed = Buffer.concat([
    query("x").subarray(0, 12),
    Buffer.from([0xc0, 0x0c, 0, 1, 0, 1]),
  ]);
  expect(decode(answerQuery(compressed, names)!).rcode).toBe(1);
  const truncated = query("example.com").subarray(0, 20);
  expect(decode(answerQuery(truncated, names)!).rcode).toBe(1);
  const notify = query("example.com");
  notify[2] = 0x20;
  expect(decode(answerQuery(notify, names)!).rcode).toBe(4);
  expect(parseQuery(query("example.com"))).toMatchObject({ name: "example.com", type: 1 });
});

test("a connection to a placeholder is decided and reported as its name", async () => {
  const f = await fixture();
  const { address } = await lookUp(f.dns, "example.com");
  const { client } = await established(f, `${address}:443`);
  expect(f.decide).toHaveBeenCalledWith(expect.anything(), "example.com", 443);
  expect(f.resolve).toHaveBeenCalledWith("example.com", expect.anything());
  expect(f.proxy.tunnels()).toEqual([expect.objectContaining({ host: "example.com", port: 443 })]);
  client.socket.destroy();

  const denied = await lookUp(f.dns, "blocked.example");
  await response(await f.open(`${denied.address}:443`), 403, true);
  expect(f.denials.at(-1)).toMatchObject({ host: "blocked.example", port: 443, lift: "grant" });
});

test("a placeholder no lookup handed out, or another client's, is refused undecided", async () => {
  const f = await fixture({ decide: () => allow() });
  await response(await f.open("198.18.0.77:443"), 403, true);
  const other = await f.proxy.issue({ server: "server-a", chat: "chat-other" });
  const { address } = await lookUp(other.dns, "example.com");
  await response(await f.open(`${address}:443`), 403, true);
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.denials.map((denial) => denial.lift)).toEqual([null, null]);
});

test("revoking a client closes its name listener", async () => {
  const f = await fixture();
  expect((await lookUp(f.dns, "example.com")).count).toBe(1);
  f.proxy.revoke(f.token);
  const [host, port] = f.dns.split(":");
  const socket = createSocket("udp4");
  const answered = await new Promise<boolean>((resolve) => {
    socket.once("message", () => resolve(true));
    socket.once("error", () => resolve(false));
    setTimeout(() => resolve(false), 300);
    socket.send(query("example.com"), Number(port), host);
  });
  socket.close();
  expect(answered).toBe(false);
  const client = await f.client();
  await write(client.socket, request("example.com:443", auth(f.token)));
  await response(client, 407);
});
