import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ComputerSettings } from "./computer-settings.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const file = async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-computer-settings-"));
  dirs.push(dir);
  return join(dir, "computer-settings.json");
};

it("starts with remote control on and no chosen agent, whatever the file holds", async () => {
  const path = await file();
  expect((await ComputerSettings.load(path)).get()).toEqual({ remote: true, agentSocket: null });
  await writeFile(path, JSON.stringify({ remote: "no", agentSocket: 3 }));
  expect((await ComputerSettings.load(path)).get()).toEqual({ remote: true, agentSocket: null });
});

it("keeps a change across a restart", async () => {
  const path = await file();
  const settings = await ComputerSettings.load(path);
  await settings.set({ remote: false, agentSocket: "/tmp/agent.sock" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    remote: false,
    agentSocket: "/tmp/agent.sock",
  });
  expect((await ComputerSettings.load(path)).get().remote).toBe(false);
});

it("relays to the chosen agent, else the environment's, else Windows' own", async () => {
  const settings = await ComputerSettings.load(await file());
  expect(settings.agentSocket({ SSH_AUTH_SOCK: "/run/agent" }, "darwin")).toBe("/run/agent");
  expect(settings.agentSocket({}, "darwin")).toBeNull();
  expect(settings.agentSocket({}, "win32")).toBe("\\\\.\\pipe\\openssh-ssh-agent");
  await settings.set({ agentSocket: "/chosen" });
  expect(settings.agentSocket({ SSH_AUTH_SOCK: "/run/agent" }, "win32")).toBe("/chosen");
});
