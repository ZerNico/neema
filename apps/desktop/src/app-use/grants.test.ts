import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AppGrants } from "./grants.ts";

describe("which apps chats may use", () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "app-grants-"));
    file = join(directory, "app-grants.json");
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  test("an answer for one chat stays with that chat", async () => {
    const grants = new AppGrants(file);
    await grants.allow("chat-a", "com.microsoft.Excel", "chat");
    expect(await grants.allowed("chat-a", "com.microsoft.Excel")).toBe(true);
    expect(await grants.allowed("chat-b", "com.microsoft.Excel")).toBe(false);
    expect(await grants.alwaysAllowed("com.microsoft.Excel")).toBe(false);
  });

  test("always counts in every chat, and from other devices", async () => {
    const grants = new AppGrants(file);
    await grants.allow("chat-a", "com.apple.mail", "always");
    expect(await grants.allowed("chat-b", "com.apple.mail")).toBe(true);
    expect(await grants.alwaysAllowed("com.apple.mail")).toBe(true);
    await grants.disallow("com.apple.mail");
    expect(await grants.allowed("chat-b", "com.apple.mail")).toBe(false);
  });

  test("survives a restart, and a gone chat's answers go with it", async () => {
    const before = new AppGrants(file);
    await before.allow("chat-a", "com.apple.finder", "chat");
    await before.allow("chat-a", "com.apple.mail", "always");
    const after = new AppGrants(file);
    expect(await after.allowed("chat-a", "com.apple.finder")).toBe(true);
    expect(await after.alwaysList()).toEqual(["com.apple.mail"]);
    await after.forgetChat("chat-a");
    expect(await new AppGrants(file).allowed("chat-a", "com.apple.finder")).toBe(false);
  });
});
