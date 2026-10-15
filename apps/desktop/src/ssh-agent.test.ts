import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentExists,
  agentKeyCount,
  answersAsAgent,
  findAgent,
  isIdentitiesAnswer,
  loadAgentChoice,
  WINDOWS_AGENT,
} from "./ssh-agent.ts";

const env = { SSH_AUTH_SOCK: "/tmp/launchd/Listeners" };

describe("findAgent", () => {
  const lookup = { os: "darwin" as const, env, chosen: null, exists: async () => true };

  it("takes the socket chosen in Settings over SSH_AUTH_SOCK", async () => {
    expect(await findAgent({ ...lookup, chosen: "/tmp/op.sock" })).toBe("/tmp/op.sock");
    expect(await findAgent(lookup)).toBe("/tmp/launchd/Listeners");
  });

  it("finds none when the socket is gone or SSH_AUTH_SOCK is not a full path", async () => {
    expect(await findAgent({ ...lookup, exists: async () => false })).toBeNull();
    expect(await findAgent({ ...lookup, env: { SSH_AUTH_SOCK: "agent.sock" } })).toBeNull();
  });

  it("uses Windows' own pipe when nothing else names one", async () => {
    expect(await findAgent({ ...lookup, os: "win32", env: {} })).toBe(WINDOWS_AGENT);
    expect(await findAgent({ ...lookup, env: {} })).toBeNull();
  });
});

/** An identities answer as an agent writes it: each key a blob and a comment. */
const identities = (keys: ReadonlyArray<readonly [string, string]>) => {
  const string = (text: string) => {
    const bytes = Buffer.from(text);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const count = Buffer.alloc(4);
  count.writeUInt32BE(keys.length);
  const payload = Buffer.concat([
    Buffer.from([12]),
    count,
    ...keys.flatMap(([blob, comment]) => [string(blob), string(comment)]),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, payload]);
};

describe("isIdentitiesAnswer", () => {
  it("takes a whole answer, with or without keys", () => {
    expect(isIdentitiesAnswer(identities([]))).toBe(true);
    expect(isIdentitiesAnswer(identities([["ssh-ed25519 blob", "me@laptop"]]))).toBe(true);
  });

  it("refuses a frame too short, cut off, padded or of another type", () => {
    expect(isIdentitiesAnswer(Buffer.from([0, 0, 0, 1, 12]))).toBe(false);
    const whole = identities([["ssh-ed25519 blob", "me@laptop"]]);
    expect(isIdentitiesAnswer(whole.subarray(0, whole.length - 1))).toBe(false);
    const padded = Buffer.concat([whole, Buffer.from([0])]);
    padded.writeUInt32BE(padded.length - 4);
    expect(isIdentitiesAnswer(padded)).toBe(false);
    const failure = identities([]);
    failure[4] = 5;
    expect(isIdentitiesAnswer(failure)).toBe(false);
  });
});

describe.runIf(process.platform !== "win32")("answersAsAgent", () => {
  const servers: Server[] = [];
  const folders: string[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true })));
  });
  const listen = async (answer: (request: Buffer) => Buffer | null) => {
    const folder = await mkdtemp(join(tmpdir(), "chat-agent-"));
    folders.push(folder);
    const path = join(folder, "agent.sock");
    const server = createServer((socket) =>
      socket.on("data", (request: Buffer) => {
        const reply = answer(request);
        if (reply) socket.write(reply);
        else socket.end();
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return path;
  };

  it("accepts a socket that lists identities", async () => {
    // SSH_AGENT_IDENTITIES_ANSWER with no keys: type 12, count 0.
    const agent = await listen(() => identities([["ssh-ed25519 blob", "me@laptop"]]));
    expect(await answersAsAgent(agent)).toBe(true);
  });

  it("counts the keys an agent holds, and none for one that is no agent", async () => {
    const two = await listen(() =>
      identities([
        ["ssh-ed25519 a", "me@laptop"],
        ["ssh-rsa b", "me@work"],
      ]),
    );
    expect(await agentKeyCount(two)).toBe(2);
    expect(await agentKeyCount(await listen(() => identities([])))).toBe(0);
    const http = await listen(() => Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"));
    expect(await agentKeyCount(http)).toBeNull();
  });

  it("refuses a socket that answers anything else, or nothing", async () => {
    const http = await listen(() => Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"));
    expect(await answersAsAgent(http)).toBe(false);
    const partial = await listen(() => Buffer.from([0, 0, 0, 1, 12]));
    expect(await answersAsAgent(partial)).toBe(false);
    const closes = await listen(() => null);
    expect(await answersAsAgent(closes)).toBe(false);
    expect(await answersAsAgent(join(tmpdir(), "chat-no-such-agent.sock"))).toBe(false);
  });
});

describe("agentExists", () => {
  it("finds a socket path, and a Windows pipe only in the pipe list", async () => {
    expect(await agentExists(tmpdir())).toBe(true);
    expect(await agentExists(join(tmpdir(), "chat-no-such-agent.sock"))).toBe(false);
    // A pipe is looked up in the pipe list, in either slash and any case, as Windows names it.
    const pipes = async () => ["OpenSSH-SSH-Agent"];
    expect(await agentExists("\\\\.\\pipe\\openssh-ssh-agent", pipes)).toBe(true);
    expect(await agentExists("//./pipe/OpenSSH-SSH-Agent", pipes)).toBe(true);
    expect(await agentExists("\\\\?\\pipe\\openssh-ssh-agent", pipes)).toBe(true);
    expect(await agentExists("\\\\.\\pipe\\chat-no-such-pipe", pipes)).toBe(false);
  });
});

describe("loadAgentChoice", () => {
  it("keeps the choice in the profile until cleared", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-agent-choice-"));
    const choice = await loadAgentChoice(directory);
    expect(choice.current()).toBeNull();
    await choice.set("/tmp/op.sock");
    expect((await loadAgentChoice(directory)).current()).toBe("/tmp/op.sock");
    await choice.set(null);
    expect((await loadAgentChoice(directory)).current()).toBeNull();
    await rm(directory, { recursive: true });
  });
});
