import type { ToolResult } from "@chat/desktop-rpc";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppGrants } from "./grants.ts";
import { type AppCall, AppUse, SharedAppDriver } from "./host.ts";

const running = (name: string) => {
  try {
    execFileSync("pgrep", ["-x", name]);
    return true;
  } catch {
    return false;
  }
};

const call = (
  name: string,
  args: Record<string, unknown>,
  more: Partial<AppCall> = {},
): AppCall => ({
  name,
  args,
  conversationId: "chat-1",
  local: true,
  signal: new AbortController().signal,
  ...more,
});

test("a machine without a driver says app use is not available", async () => {
  const apps = new AppUse({
    driver: new SharedAppDriver(null),
    scope: "https://chat.example",
    grants: new AppGrants(join(tmpdir(), "never-written.json")),
    ask: async () => "chat",
    explainPermissions: async () => {},
    log: () => {},
  });
  const result = await apps.run(call("app_look", { app: "Calculator" }));
  expect(result).toMatchObject({ ok: false, summary: "Apps can't be used here" });
});

/**
 * The host over the real driver and Calculator, opt-in like real-driver.test.ts: consent, the
 * other-device rule, references and picture pixels as the model sends them.
 */
const EXECUTABLE = process.env.NEEMA_APP_DRIVER;

describe.skipIf(!EXECUTABLE || process.platform !== "darwin")("app use on this Mac", () => {
  let directory: string;
  let driver: SharedAppDriver;
  let apps: AppUse;
  let grants: AppGrants;
  const asked: string[] = [];
  let answer: "chat" | "always" | "deny" = "deny";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "app-use-"));
    grants = new AppGrants(join(directory, "grants.json"));
    driver = new SharedAppDriver(EXECUTABLE!);
    apps = new AppUse({
      driver,
      scope: "https://one.example",
      grants,
      ask: async (app) => {
        asked.push(app.name);
        return answer;
      },
      explainPermissions: async () => {},
      log: () => {},
    });
  });
  afterAll(async () => {
    driver.close();
    await rm(directory, { recursive: true, force: true });
  });

  const lineOf = (result: ToolResult, text: string) =>
    result.detail.split("\n").find((line) => line.includes(text))!;
  const refOf = (result: ToolResult, label: string) =>
    lineOf(result, `button "${label}"`).trim().split(" ")[0]!;
  /** The picture-pixel centre the outline gives for a button. */
  const pointOf = (result: ToolResult, label: string) => {
    const [x, y] = /@(\d+),(\d+)/
      .exec(lineOf(result, `button "${label}"`))!
      .slice(1)
      .map(Number);
    return { x, y };
  };
  const display = (result: ToolResult) =>
    [...result.detail.matchAll(/text = "([^"]*)"/g)].map((match) => match[1]).at(-1);

  test("from another device, an app not always allowed is refused without asking", async () => {
    const result = await apps.run(call("app_look", { app: "Calculator" }, { local: false }));
    expect(result).toMatchObject({ ok: false, summary: "Calculator needs the user's OK" });
    expect(asked).toEqual([]);
  });

  test("a refusal at the machine is final for that call", async () => {
    answer = "deny";
    const result = await apps.run(call("app_open", { app: "Calculator" }));
    expect(result).toMatchObject({ ok: false, summary: "You declined Calculator" });
    expect(asked).toEqual(["Calculator"]);
  });

  test("allowed in the chat, it opens, looks, and acts by reference and by pixel", async () => {
    answer = "chat";
    asked.length = 0;
    // Not running: an app is launched before its window exists, and the look must wait for it.
    execFileSync("osascript", ["-e", 'quit app "Calculator"']);
    // Quitting returns before the app has gone; opening it meanwhile would find the old one.
    for (let tries = 0; running("Calculator") && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const opened = await apps.run(call("app_open", { app: "com.apple.calculator" }));
    expect(opened.ok).toBe(true);
    // The row names the app as macOS does, not by the id the model used.
    expect(opened.app).toEqual({ name: "Calculator" });
    expect(opened.file?.mediaType).toBe("image/png");
    expect(await grants.allowed("chat-1", "com.apple.calculator")).toBe(true);

    let result = await apps.run(call("app_key", { app: "com.apple.calculator", keys: "Escape" }));
    result = await apps.run(call("app_key", { app: "com.apple.calculator", keys: "Escape" }));
    result = await apps.run(call("app_click", { app: "Calculator", ref: refOf(result, "7") }));
    result = await apps.run(
      call("app_click", { app: "Calculator", ...pointOf(result, "Multiply") }),
    );
    result = await apps.run(call("app_type", { app: "Calculator", text: "6" }));
    result = await apps.run(call("app_key", { app: "Calculator", keys: "Return" }));
    // The look after an action waits for the redraw; one more look covers a slow one.
    if (display(result) !== "42") result = await apps.run(call("app_look", { app: "Calculator" }));
    expect(display(result)).toBe("42");
    expect(asked).toEqual(["Calculator"]);
  });

  test("another chat's look in between makes the next action look again first", async () => {
    answer = "chat";
    await apps.run(call("app_look", { app: "Calculator" }, { conversationId: "chat-2" }));
    const result = await apps.run(call("app_key", { app: "Calculator", keys: "Escape" }));
    expect(result).toMatchObject({ ok: false, summary: "Looked at Calculator first" });
    expect(result.detail).toMatch(/Nothing was done/);
  });

  test("another server's chat of the same id is another chat in the shared driver", async () => {
    answer = "always";
    const other = new AppUse({
      driver,
      scope: "https://two.example",
      grants: new AppGrants(join(directory, "other-grants.json")),
      ask: async () => answer,
      explainPermissions: async () => {},
      log: () => {},
    });
    await apps.run(call("app_look", { app: "Calculator" }));
    await other.run(call("app_look", { app: "Calculator" }));
    const result = await apps.run(call("app_key", { app: "Calculator", keys: "Escape" }));
    expect(result).toMatchObject({ ok: false, summary: "Looked at Calculator first" });
  });

  test("off-limits apps and unknown references are explained", async () => {
    const terminal = await apps.run(call("app_look", { app: "Terminal" }));
    expect(terminal.ok).toBe(false);
    expect(terminal.detail).toMatch(/never available/);
    await apps.run(call("app_look", { app: "Calculator" }));
    const stale = await apps.run(call("app_click", { app: "Calculator", ref: "e9999" }));
    expect(stale).toMatchObject({ ok: false, summary: "Unknown reference" });
  });
});
