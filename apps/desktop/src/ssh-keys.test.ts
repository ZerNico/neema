import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentKeyCount } from "./ssh-agent.ts";
import { addKeysToAgent, defaultKeyFiles, loadKeyConsent } from "./ssh-keys.ts";

const folders: string[] = [];
const directory = async () => {
  // Short, so an agent's socket path fits.
  const folder = await mkdtemp(join(tmpdir(), "k-"));
  folders.push(folder);
  return folder;
};
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("the person's key files", () => {
  it("finds the default keys present, in ssh's order", async () => {
    const home = await directory();
    await mkdir(join(home, ".ssh"));
    expect(await defaultKeyFiles(home)).toEqual([]);
    await writeFile(join(home, ".ssh", "id_rsa"), "");
    await writeFile(join(home, ".ssh", "id_ed25519"), "");
    await writeFile(join(home, ".ssh", "deploy"), "");
    expect(await defaultKeyFiles(home)).toEqual([
      join(home, ".ssh", "id_ed25519"),
      join(home, ".ssh", "id_rsa"),
    ]);
  });

  it("remembers what the person agreed to across loads, and nothing from a broken file", async () => {
    const folder = await directory();
    const consent = await loadKeyConsent(folder);
    expect(consent.current()).toEqual([]);
    await consent.set(["/Users/me/.ssh/id_rsa"]);
    expect((await loadKeyConsent(folder)).current()).toEqual(["/Users/me/.ssh/id_rsa"]);
    await writeFile(join(folder, "ssh-keys.json"), '{"keys":["relative",1]}');
    expect((await loadKeyConsent(folder)).current()).toEqual([]);
    await writeFile(join(folder, "ssh-keys.json"), "{");
    expect((await loadKeyConsent(folder)).current()).toEqual([]);
  });

  const hasOpenSsh =
    process.platform !== "win32" &&
    ["ssh-agent", "ssh-keygen"].every((tool) => {
      try {
        execFileSync("/bin/sh", ["-c", `command -v ${tool}`]);
        return true;
      } catch {
        return false;
      }
    });

  it.runIf(hasOpenSsh)("adds a key without a passphrase to a real agent", async () => {
    const folder = await directory();
    const socket = join(folder, "a.sock");
    const key = join(folder, "id_ed25519");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const agent = spawn("ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
    try {
      // The agent made its socket once it answers; asked until then.
      while (!existsSync(socket) || (await agentKeyCount(socket)) === null)
        await new Promise((resolve) => setImmediate(resolve));
      expect(await agentKeyCount(socket)).toBe(0);
      await addKeysToAgent({
        os: process.platform,
        socket,
        keys: [key],
        directory: join(folder, "app"),
      });
      expect(await agentKeyCount(socket)).toBe(1);
    } finally {
      agent.kill();
    }
  });
});
