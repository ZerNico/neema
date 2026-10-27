import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRelay, passesToAgent } from "./agent.ts";
import { agentKeyCount } from "./ssh-keys.ts";

const hasOpenSsh = (() => {
  try {
    execFileSync("ssh-agent", ["-h"], { stdio: "ignore" });
  } catch (error) {
    return (error as { code?: string }).code !== "ENOENT";
  }
  return true;
})();

const sshAdd = (socket: string, ...args: string[]) =>
  new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(
      "ssh-add",
      args,
      { env: { ...process.env, SSH_AUTH_SOCK: socket, SSH_ASKPASS_REQUIRE: "never" } },
      (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` }),
    );
  });

/** The relay in front of a real agent of the test's own, never the person's. */
describe.skipIf(!hasOpenSsh || process.platform === "win32")("the agent relay", () => {
  let dir: string;
  let socket: string;
  let agent: ChildProcess;
  let relay: AgentRelay;
  const key = { origin: "https://test", conversationId: "chat-1" };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "neema-relay-test-"));
    socket = join(dir, "agent.sock");
    agent = spawn("ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
    for (let tries = 0; tries < 50 && (await agentKeyCount(socket, 200)) === null; tries++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "id")]);
    await sshAdd(socket, join(dir, "id"));
    relay = new AgentRelay(() => socket);
    relay.allow(key);
  });

  afterAll(async () => {
    relay.close();
    agent.kill();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the keys for a login, but will not remove or lock them", async () => {
    const through = relay.socketFor(key);
    const listed = await sshAdd(through, "-l");
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain("ED25519");

    expect((await sshAdd(through, "-D")).ok).toBe(false);
    // The person's agent is as it was.
    expect(await agentKeyCount(socket)).toBe(1);
    expect((await sshAdd(through, "-l")).ok).toBe(true);
  });
});

describe("passesToAgent", () => {
  const extension = (name: string) => {
    const bytes = Buffer.from(name, "latin1");
    const body = Buffer.concat([Buffer.from([27]), Buffer.alloc(4), bytes]);
    body.writeUInt32BE(bytes.length, 1);
    const message = Buffer.alloc(4 + body.length);
    message.writeUInt32BE(body.length, 0);
    body.copy(message, 4);
    return message;
  };

  it("passes listing, signing and the session binding ssh sends first", () => {
    expect(passesToAgent(Buffer.from([0, 0, 0, 1, 11]))).toBe(true);
    expect(passesToAgent(Buffer.from([0, 0, 0, 1, 13]))).toBe(true);
    expect(passesToAgent(extension("session-bind@openssh.com"))).toBe(true);
  });

  it("refuses locking, adding and other extensions", () => {
    // LOCK, ADD_IDENTITY, REMOVE_ALL_IDENTITIES.
    for (const type of [22, 17, 19])
      expect(passesToAgent(Buffer.from([0, 0, 0, 1, type]))).toBe(false);
    expect(passesToAgent(extension("query"))).toBe(false);
  });
});
