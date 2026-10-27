import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatKey } from "./vms.ts";

const chatId = (key: ChatKey) =>
  createHash("sha256")
    .update(`${key.origin}\u0000${key.conversationId}`)
    .digest("hex")
    .slice(0, 16);

const keyOf = (origin: string, conversationId: string) => `${origin}\u0000${conversationId}`;

/** OpenSSH's agent protocol: REQUEST_IDENTITIES, SIGN_REQUEST, EXTENSION, and FAILURE. */
const LIST = 11;
const SIGN = 13;
const EXTENSION = 27;
const FAILURE = Buffer.from([0, 0, 0, 1, 5]);
/** What `ssh` sends before signing a host-bound login; refusing it is fine, passing it better. */
const SESSION_BIND = "session-bind@openssh.com";
/** OpenSSH's own ceiling for one agent message. */
const MAX_MESSAGE = 256 * 1024;

/** Whether a guest's request is one a login needs: list the keys, sign, bind the session. */
export const passesToAgent = (message: Buffer) => {
  const type = message[4];
  if (type === LIST || type === SIGN) return true;
  if (type !== EXTENSION || message.length < 9) return false;
  const length = message.readUInt32BE(5);
  return message.subarray(9, 9 + length).toString("latin1") === SESSION_BIND;
};

/** Splits a byte stream into whole agent messages, length prefix included. */
const framer = (onMessage: (message: Buffer) => void, onTooLarge: () => void) => {
  let pending = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (length > MAX_MESSAGE) return onTooLarge();
      if (pending.length < 4 + length) return;
      onMessage(pending.subarray(0, 4 + length));
      pending = pending.subarray(4 + length);
    }
  };
};

/**
 * The person's SSH agent, relayed into chat VMs that may use it. Each chat gets its own host
 * socket (a named pipe on Windows), which microsandbox exposes to the guest over vsock; a
 * connection is relayed to the agent only while the server says the chat is allowed, and
 * revoking it cuts the connections already open. The agent's own socket is never mounted, and
 * only what a login needs passes (`passesToAgent`): a guest can sign with the person's keys,
 * but not add, remove or lock them in their agent.
 */
export class AgentRelay {
  private readonly directory: string | null;
  private readonly listeners = new Map<string, { server: Server; path: string }>();
  private readonly open = new Map<string, Set<Socket>>();
  private allowedChats = new Set<string>();

  constructor(
    /** The agent to relay to, read for each connection: `SSH_AUTH_SOCK`, a chosen socket, the Windows pipe. */
    private readonly agent: () => string | null,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    // Sockets go in a folder of their own that only this user can enter; short, for the path
    // limit of a socket address.
    this.directory = platform === "win32" ? null : mkdtempSync(join(tmpdir(), "neema-agent-"));
  }

  /** The whole list of chats allowed the agent on one server, as the server sent it. */
  setAllowed(origin: string, conversationIds: ReadonlyArray<string>) {
    const next = new Set(
      [...this.allowedChats].filter((entry) => !entry.startsWith(`${origin}\u0000`)),
    );
    for (const id of conversationIds) next.add(keyOf(origin, id));
    for (const [entry, sockets] of this.open)
      if (!next.has(entry)) for (const socket of sockets) socket.destroy();
    this.allowedChats = next;
  }

  allow(key: ChatKey) {
    this.allowedChats.add(keyOf(key.origin, key.conversationId));
  }

  /** The chat is gone: its allowance and open connections go with it. */
  forget(key: ChatKey) {
    const id = keyOf(key.origin, key.conversationId);
    this.allowedChats.delete(id);
    for (const socket of this.open.get(id) ?? []) socket.destroy();
  }

  /** The chats of one server allowed the agent, to keep. */
  allowed(origin: string) {
    return [...this.allowedChats]
      .filter((entry) => entry.startsWith(`${origin}\u0000`))
      .map((entry) => entry.slice(origin.length + 1));
  }

  isAllowed(key: ChatKey) {
    return this.allowedChats.has(keyOf(key.origin, key.conversationId));
  }

  /** The host path the chat's VM reaches the relay at, listening by the time it is used. */
  socketFor(key: ChatKey): string {
    const id = keyOf(key.origin, key.conversationId);
    const existing = this.listeners.get(id);
    if (existing) return existing.path;
    const path =
      this.platform === "win32"
        ? `\\\\.\\pipe\\neema-agent-${chatId(key)}`
        : join(this.directory!, `${chatId(key)}.sock`);
    const server = createServer((guest) => this.relay(id, guest));
    server.on("error", () => {});
    server.listen(path);
    this.listeners.set(id, { server, path });
    return path;
  }

  close() {
    for (const { server } of this.listeners.values()) server.close();
    for (const sockets of this.open.values()) for (const socket of sockets) socket.destroy();
    this.listeners.clear();
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }

  private relay(id: string, guest: Socket) {
    const target = this.allowedChats.has(id) ? this.agent() : null;
    if (!target) {
      guest.destroy();
      return;
    }
    const agent = createConnection(target);
    const sockets = this.open.get(id) ?? new Set<Socket>();
    this.open.set(id, sockets);
    sockets.add(guest);
    const done = () => {
      sockets.delete(guest);
      guest.destroy();
      agent.destroy();
    };
    guest.on("error", done).on("close", done);
    agent.on("error", done).on("close", done);
    // One request at a time, so a refused one answered here never overtakes a forwarded one.
    const waiting: Buffer[] = [];
    let forwarded = false;
    const next = () => {
      while (!forwarded && waiting.length > 0) {
        const message = waiting.shift()!;
        if (passesToAgent(message)) {
          forwarded = true;
          agent.write(message);
        } else guest.write(FAILURE);
      }
    };
    guest.on(
      "data",
      framer((message) => {
        waiting.push(message);
        next();
      }, done),
    );
    agent.on(
      "data",
      framer((message) => {
        guest.write(message);
        forwarded = false;
        next();
      }, done),
    );
  }
}
