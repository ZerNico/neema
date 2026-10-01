import type { BrowserSnapshot, DesktopBrowser, DesktopBrowserAgent } from "@chat/desktop-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserToolName } from "~/modules/desktop/tool-schema.ts";
import { browserTabs, type WebviewElement } from "./browser-store.ts";
import { executeBrowserTool } from "./execute-browser.ts";

const browser = {
  partition: "persist:browser-0123456789abcdef",
  temporaryPartition: (id: string) => `browser-temp-0123456789abcdef-${id}`,
  setLifecycle: async () => {},
  onOpenTab: () => () => {},
  onFavicon: () => () => {},
  openExternal: async () => {},
} satisfies DesktopBrowser;

let blocked: string | null = null;
let snapshot: BrowserSnapshot;
const agent = {
  snapshot: vi.fn(async () => snapshot),
  waitFor: vi.fn(async () => ({ met: true, url: "https://a.test/" })),
  drive: vi.fn(async (_id: number, driving: unknown) => ({ blocked: driving ? null : blocked })),
  siteAllowed: async () => false,
  allowSite: async () => {},
  allowedSites: async () => [],
  revokeSite: async () => {},
} satisfies DesktopBrowserAgent;

// Stands in for BrowserHost: a page that goes live gets an element and a guest
// id, and loading an address moves the tab there.
let nextGuest = 1;
let stopHost: () => void;
const host = () => {
  const attached = new Set<string>();
  return browserTabs.subscribe(() => {
    for (const tab of browserTabs.all().values()) {
      if (!tab.live || attached.has(tab.id)) continue;
      attached.add(tab.id);
      const webview = Object.assign(document.createElement("webview") as WebviewElement, {
        loadURL: vi.fn(async (url: string) => browserTabs.update(tab.id, { url, title: "Page" })),
        goBack: vi.fn(),
        goForward: vi.fn(),
        reload: vi.fn(),
        stop: vi.fn(),
      });
      browserTabs.attach(tab.id, webview);
      queueMicrotask(() => browserTabs.update(tab.id, { webContentsId: nextGuest++ }));
    }
  });
};

const run = (
  name: BrowserToolName,
  args: Record<string, unknown>,
  extra: { callId?: string; meta?: { temporary?: boolean } } = {},
) =>
  executeBrowserTool(
    { callId: extra.callId ?? "call-1", conversationId: "c1", name, args, meta: extra.meta },
    60_000,
    browser,
    agent,
  );

beforeEach(() => {
  blocked = null;
  snapshot = {
    url: "https://a.test/",
    title: "A",
    text: '- [e1] link "Next"',
    truncated: false,
    screenshot: null,
  };
  stopHost = host();
});
afterEach(() => {
  stopHost();
  for (const id of browserTabs.all().keys()) browserTabs.remove(id);
  vi.clearAllMocks();
});

const own = () => [...browserTabs.all().values()].filter((tab) => tab.owner === "c1");

describe("browser tools in the page", () => {
  it("opens a page in a new labelled tab of the chat, driven, and asks the panel to show it", async () => {
    const result = await run("browser_open", { url: "https://a.test/" });
    expect(result).toMatchObject({ ok: true, summary: "Opened a.test in t1" });
    const [tab] = own();
    expect(tab).toMatchObject({
      label: "t1",
      url: "https://a.test/",
      partition: browser.partition,
    });
    expect(tab!.revealAt).toBeGreaterThan(0);
    expect(agent.drive).toHaveBeenNthCalledWith(1, tab!.webContentsId, {
      conversationId: "c1",
      allow: ["https://a.test/"],
    });
    expect(agent.drive).toHaveBeenLastCalledWith(tab!.webContentsId, null);
  });

  it("finds the tab a replayed call already opened instead of opening another", async () => {
    await run("browser_open", { url: "https://a.test/" });
    await run("browser_open", { url: "https://a.test/" });
    expect(own()).toHaveLength(1);
    await run("browser_open", { url: "https://b.test/" }, { callId: "call-2" });
    expect(own().map((tab) => tab.label)).toEqual(["t1", "t2"]);
  });

  it("browses a temporary chat in its in-memory profile", async () => {
    await run("browser_open", { url: "https://a.test/" }, { meta: { temporary: true } });
    expect(own()[0]?.partition).toBe(browser.temporaryPartition("c1"));
  });

  it("reports a site the page was stopped from, so the model asks first", async () => {
    blocked = "evil.test";
    const result = await run("browser_open", { url: "https://a.test/" });
    expect(result).toMatchObject({ ok: false, summary: "Stopped before evil.test" });
    expect(result.detail).toContain("browser_navigate");
  });

  it("explains a malformed call instead of guessing", async () => {
    expect(await run("browser_open", { url: "javascript:alert(1)" })).toMatchObject({ ok: false });
    expect(await run("browser_snapshot", {})).toMatchObject({
      ok: false,
      detail: "This chat has no browser tabs. Open one with browser_open.",
    });
    await run("browser_open", { url: "https://a.test/" });
    await run("browser_open", { url: "https://b.test/" }, { callId: "call-2" });
    expect(await run("browser_snapshot", {})).toMatchObject({ detail: "Name a tab: t1, t2." });
    expect(await run("browser_snapshot", { tab: "t9" })).toMatchObject({
      detail: "There is no tab t9 in this chat. Its tabs are t1, t2.",
    });
    expect(await run("browser_wait_for", { tab: "t1" })).toMatchObject({ ok: false });
  });

  it("wakes a discarded tab before reading it", async () => {
    browserTabs.restore("kept", {
      owner: "c1",
      partition: browser.partition,
      url: "https://a.test/",
    });
    expect(browserTabs.get("kept")?.live).toBe(false);
    const result = await run("browser_snapshot", { tab: "t1" });
    expect(browserTabs.get("kept")?.live).toBe(true);
    expect(result).toMatchObject({ ok: true, summary: "Read A" });
    expect(result.detail).toContain('- [e1] link "Next"');
  });

  it("hands a screenshot to the model, and says when there is none", async () => {
    await run("browser_open", { url: "https://a.test/" });
    const missing = await run("browser_snapshot", { tab: "t1", screenshot: true });
    expect(missing.file).toBeUndefined();
    expect(missing.detail).toContain("No screenshot");
    snapshot = { ...snapshot, screenshot: { mediaType: "image/jpeg", base64: "AQID" } };
    const shot = await run("browser_snapshot", { tab: "t1", screenshot: true });
    expect(shot.file).toEqual({ mediaType: "image/jpeg", base64: "AQID", name: "t1.jpg" });
  });

  it("lists the chat's tabs by name", async () => {
    await run("browser_open", { url: "https://a.test/" });
    const result = await run("browser_tabs", {});
    expect(result.detail).toBe("t1: Page\nhttps://a.test/");
  });
});
