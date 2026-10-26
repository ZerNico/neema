import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addKey, agentKeyCount, defaultKey } from "./ssh-keys.ts";

const hasOpenSsh = (() => {
  try {
    execFileSync("ssh-agent", ["-h"], { stdio: "ignore" });
  } catch (error) {
    // `-h` is not an option: an installed agent still says so and exits non-zero.
    return (error as { code?: string }).code !== "ENOENT";
  }
  return true;
})();

/** A real agent of the test's own, so the person's is never touched. */
describe.skipIf(!hasOpenSsh || process.platform === "win32")("the person's SSH agent", () => {
  let dir: string;
  let socket: string;
  let agent: ChildProcess;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "neema-agent-test-"));
    socket = join(dir, "agent.sock");
    agent = spawn("ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
    for (let tries = 0; tries < 50 && (await agentKeyCount(socket, 200)) === null; tries++)
      await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterAll(async () => {
    agent.kill();
    await rm(dir, { recursive: true, force: true });
  });

  it("counts its keys, and adds the default one without passing it through the app", async () => {
    const home = join(dir, "home");
    await mkdir(join(home, ".ssh"), { recursive: true });
    expect(await defaultKey(home)).toBeNull();
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(home, ".ssh/id_ed25519")]);
    const key = await defaultKey(home);
    expect(key).toBe(join(home, ".ssh/id_ed25519"));

    expect(await agentKeyCount(socket)).toBe(0);
    // The non-macOS path: no passphrase dialog, so only a key without one is added.
    expect(await addKey(socket, key!, "Passphrase", "linux")).toBe(true);
    expect(await agentKeyCount(socket)).toBe(1);
  });

  it("says nothing for an agent that is not there", async () => {
    expect(await agentKeyCount(join(dir, "missing.sock"), 200)).toBeNull();
  });
});
