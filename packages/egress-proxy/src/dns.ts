import { createSocket } from "node:dgram";
import { canonicalHost } from "./host.ts";
import type { NameTable } from "./names.ts";

const A = 1;
const ANY = 255;
const IN = 1;
const NOERROR = 0;
const FORMERR = 1;
const SERVFAIL = 2;
const NXDOMAIN = 3;
const NOTIMP = 4;
const TTL = 60;

/** The one question of a standard query, or the rcode to answer a malformed one with. */
export function parseQuery(
  message: Buffer,
): { name: string; type: number; end: number } | { rcode: number } | undefined {
  // Too short for a header, or a response: nothing to answer.
  if (message.length < 12 || message[2]! & 0x80) return;
  const opcode = (message[2]! >> 3) & 0x0f;
  if (opcode !== 0) return { rcode: NOTIMP };
  if (message.readUInt16BE(4) !== 1) return { rcode: FORMERR };
  const labels: string[] = [];
  let at = 12;
  let length = 0;
  for (;;) {
    const size = message[at];
    // A query's name is never compressed; a pointer or an overrun is malformed.
    if (size === undefined || size > 63) return { rcode: FORMERR };
    at += 1;
    if (size === 0) break;
    length += size + 1;
    if (length > 255 || at + size > message.length) return { rcode: FORMERR };
    labels.push(message.subarray(at, at + size).toString("latin1"));
    at += size;
  }
  if (at + 4 > message.length) return { rcode: FORMERR };
  const type = message.readUInt16BE(at);
  if (message.readUInt16BE(at + 2) !== IN) return { rcode: NOTIMP };
  return { name: labels.join("."), type, end: at + 4 };
}

function reply(query: Buffer, end: number, rcode: number, address?: string) {
  const question = end > 12 ? query.subarray(12, end) : Buffer.alloc(0);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  // Response, the query's opcode and recursion-desired bit, recursion available.
  header[2] = 0x80 | (query[2]! & 0x79);
  header[3] = 0x80 | rcode;
  header.writeUInt16BE(question.length ? 1 : 0, 4);
  header.writeUInt16BE(address ? 1 : 0, 6);
  if (!address) return Buffer.concat([header, question]);
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(A, 2);
  record.writeUInt16BE(IN, 4);
  record.writeUInt32BE(TTL, 6);
  record.writeUInt16BE(4, 10);
  address.split(".").forEach((part, index) => (record[12 + index] = Number(part)));
  return Buffer.concat([header, question, record]);
}

/** Answers a query from the table: A gets the name's placeholder, every other type nothing. */
export function answerQuery(message: Buffer, names: NameTable): Buffer | undefined {
  const query = parseQuery(message);
  if (!query) return;
  if ("rcode" in query) return reply(message, 12, query.rcode);
  const canonical = canonicalHost(query.name);
  if (!canonical.ok || canonical.kind !== "name") return reply(message, query.end, NXDOMAIN);
  // IPv6 has no placeholders: AAAA answers empty and clients fall back to the A record.
  if (query.type !== A && query.type !== ANY) return reply(message, query.end, NOERROR);
  const address = names.address(canonical.host);
  return address
    ? reply(message, query.end, NOERROR, address)
    : reply(message, query.end, SERVFAIL);
}

/** A UDP listener on loopback answering one client's queries. */
export function serveNames(names: NameTable, log: (message: string) => void) {
  const socket = createSocket("udp4");
  socket.on("message", (message, peer) => {
    const answer = answerQuery(message, names);
    if (answer) socket.send(answer, peer.port, peer.address);
  });
  socket.on("error", () => log("Egress proxy: name listener failed"));
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.removeListener("error", reject);
      // Revoking and a failed start can both close it; the second close is a no-op.
      let closing: Promise<void> | undefined;
      resolve({
        port: socket.address().port,
        close: () => (closing ??= new Promise<void>((done) => socket.close(() => done()))),
      });
    });
  });
}
