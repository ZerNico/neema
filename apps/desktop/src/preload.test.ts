import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_ALLOW_SITE,
  BROWSER_ACT,
  BROWSER_BEGIN,
  BROWSER_END,
  BROWSER_CANCEL,
  BROWSER_NAVIGATE,
  BROWSER_DRIVE,
  BROWSER_FAVICON,
  BROWSER_LIFECYCLE,
  BROWSER_SNAPSHOT,
  BROWSER_OPEN_TAB,
  PROTOCOL_VERSION,
  type BrowserOpenTab,
  type DesktopAuth,
  type DesktopBrowser,
  type DesktopChrome,
} from "@chat/desktop-rpc";
import { BROWSER_PROFILE_ARGUMENT } from "./browser/partitions.ts";
import {
  CHANGE_SERVER,
  CHROME_GET_STATE,
  CHROME_SET_THEME,
  CHROME_STATE,
  CONNECT,
  CONNECT_CURRENT,
  FIXED_SERVER_ARGUMENT,
  RECOVERY_RETRY,
} from "./chrome.ts";
import { SIGN_IN_TICKET } from "./sign-in-link.ts";

const probe = (
  entry: "preload.ts" | "connect-preload.ts",
  protocol: string,
  argv: readonly string[] = [],
) => {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    define: { __BUILD_STAMP__: JSON.stringify("preload-test") },
  });
  const exposed = new Map<string, Record<string, unknown>>();
  const ipc = Object.assign(new EventEmitter(), {
    invoke: vi.fn(async (): Promise<unknown> => ({ fullscreen: true })),
  });
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, value: Record<string, unknown>) => exposed.set(key, value),
    },
    ipcRenderer: ipc,
  };
  const requireModule = vi.fn((name: string) => {
    if (name !== "electron") throw new Error(`Unavailable in sandbox: ${name}`);
    return electron;
  });
  runInNewContext(result.outputFiles[0]!.text, {
    require: requireModule,
    process: { platform: "darwin", argv: ["electron", ...argv] },
    location: { protocol },
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    exports: {},
    module: { exports: {} },
  });
  return { exposed, ipc, requireModule };
};

describe("restricted bundled preloads", () => {
  it("exposes optional chrome without changing the protocol or leaking Electron events", async () => {
    const { exposed, ipc, requireModule } = probe("preload.ts", "https:");
    const bridge = exposed.get("__chatDesktop")!;
    expect(bridge.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(bridge.request).toBeTypeOf("function");
    expect(exposed.has("__chatRecovery")).toBe(false);
    const chrome = bridge.chrome as DesktopChrome;
    expect(chrome.platform).toBe("darwin");
    expect(await chrome.getState()).toEqual({ fullscreen: true });
    expect(ipc.invoke).toHaveBeenLastCalledWith(CHROME_GET_STATE);
    const listener = vi.fn();
    const unsubscribe = chrome.onState(listener);
    const electronEvent = { sender: { privileged: true } };
    ipc.emit(CHROME_STATE, electronEvent, { fullscreen: false, extra: "not public" });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ fullscreen: false });
    unsubscribe();
    expect(ipc.listenerCount(CHROME_STATE)).toBe(0);
    ipc.emit(CHROME_STATE, electronEvent, { fullscreen: true });
    expect(listener).toHaveBeenCalledTimes(1);
    await chrome.setTheme("system");
    expect(ipc.invoke).toHaveBeenLastCalledWith(CHROME_SET_THEME, "system");
    expect(requireModule.mock.calls.every(([name]) => name === "electron")).toBe(true);
  });

  it("offers a browser only for the profile main named, without leaking Electron events", async () => {
    expect(probe("preload.ts", "https:").exposed.get("__chatDesktop")!.browser).toBeNull();
    const profile = "0123456789abcdef";
    const { exposed, ipc } = probe("preload.ts", "https:", [
      `${BROWSER_PROFILE_ARGUMENT}=${profile}`,
    ]);
    const browser = exposed.get("__chatDesktop")!.browser as DesktopBrowser;
    expect(browser.partition).toBe(`persist:browser-${profile}`);
    expect(browser.temporaryPartition("c1")).toBe(`browser-temp-${profile}-c1`);
    await browser.setLifecycle(7, "frozen");
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_LIFECYCLE, {
      webContentsId: 7,
      state: "frozen",
    });
    const electronEvent = { sender: { privileged: true } };
    const opened: BrowserOpenTab[] = [];
    const unsubscribe = browser.onOpenTab((event) => opened.push(event));
    ipc.emit(BROWSER_OPEN_TAB, electronEvent, { webContentsId: 7, url: "https://a.test", x: 1 });
    unsubscribe();
    ipc.emit(BROWSER_OPEN_TAB, electronEvent, { webContentsId: 7, url: "https://b.test" });
    expect(opened).toEqual([{ webContentsId: 7, url: "https://a.test" }]);
    const icons: unknown[] = [];
    browser.onFavicon((event) => icons.push(event));
    ipc.emit(BROWSER_FAVICON, electronEvent, {
      webContentsId: 7,
      dataUrl: "data:image/png;base64,AQ",
      x: 1,
    });
    expect(icons).toEqual([{ webContentsId: 7, dataUrl: "data:image/png;base64,AQ" }]);
    // The model's browser surface goes to its own channels, with plain values only.
    const agent = browser.agent!;
    await agent.begin("call-1", "c1", 1000);
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_BEGIN, {
      callId: "call-1",
      conversationId: "c1",
      deadline: 1000,
    });
    await agent.navigate(7, { url: "https://a.test/" }, "call-1");
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_NAVIGATE, {
      webContentsId: 7,
      target: { url: "https://a.test/" },
      callId: "call-1",
    });
    await agent.snapshot(7, { screenshot: true }, "call-1");
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_SNAPSHOT, {
      webContentsId: 7,
      screenshot: true,
      callId: "call-1",
    });
    await agent.drive(7, { conversationId: "c1", allow: ["https://a.test/"] }, "call-1");
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_DRIVE, {
      webContentsId: 7,
      driving: { conversationId: "c1", allow: ["https://a.test/"] },
      callId: "call-1",
    });
    await agent.drive(7, null, "call-1");
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_DRIVE, {
      webContentsId: 7,
      driving: null,
      callId: "call-1",
    });
    const action = { kind: "evaluate", callId: "stable-action", expression: "1" } as const;
    await agent.act(7, action, "call-1");
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_ACT, {
      webContentsId: 7,
      action,
      callId: "call-1",
    });
    await agent.cancel("call-1");
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_CANCEL, { callId: "call-1" });
    await agent.end("call-1");
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_END, { callId: "call-1" });
    await agent.allowSite("c1", "https://a.test/", "always");
    expect(ipc.invoke).toHaveBeenLastCalledWith(BROWSER_ALLOW_SITE, {
      conversationId: "c1",
      url: "https://a.test/",
      scope: "always",
    });
  });

  it("hands the page no file paths and no settings channels beside its procedures", () => {
    const { exposed } = probe("preload.ts", "https:");
    const bridge = exposed.get("__chatDesktop")!;
    expect(Object.keys(bridge).toSorted()).toEqual([
      "auth",
      "browser",
      "build",
      "chrome",
      "protocolVersion",
      "request",
      "systemLocale",
    ]);
  });

  it("withholds the server switch from every document while the server is pinned", () => {
    const remote = probe("preload.ts", "https:", [FIXED_SERVER_ARGUMENT]);
    expect((remote.exposed.get("__chatDesktop")!.auth as DesktopAuth).canChangeServer).toBe(false);
    const local = probe("preload.ts", "file:", [FIXED_SERVER_ARGUMENT]);
    expect(local.exposed.get("__chatRecovery")!.canChangeServer).toBe(false);
  });

  it("lets the site ask for the server chooser and surfaces a refusal as an error", async () => {
    const { exposed, ipc } = probe("preload.ts", "https:");
    const auth = exposed.get("__chatDesktop")!.auth as DesktopAuth;
    expect(auth.canChangeServer).toBe(true);
    ipc.invoke.mockResolvedValueOnce({ ok: true });
    await expect(auth.changeServer()).resolves.toBeUndefined();
    expect(ipc.invoke).toHaveBeenLastCalledWith(CHANGE_SERVER);
    ipc.invoke.mockResolvedValueOnce({ ok: false, message: "The server is fixed." });
    await expect(auth.changeServer()).rejects.toThrow("The server is fixed.");
  });

  it("forwards sign-in tickets as strings only, until unsubscribed", () => {
    const { exposed, ipc } = probe("preload.ts", "https:");
    const auth = exposed.get("__chatDesktop")!.auth as DesktopAuth;
    const listener = vi.fn();
    const unsubscribe = auth.onTicket(listener);
    const electronEvent = { sender: { privileged: true } };
    ipc.emit(SIGN_IN_TICKET, electronEvent, { ticket: "object" });
    ipc.emit(SIGN_IN_TICKET, electronEvent, "K7MX");
    expect(listener).toHaveBeenCalledExactlyOnceWith("K7MX");
    unsubscribe();
    ipc.emit(SIGN_IN_TICKET, electronEvent, "again");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("holds a ticket that arrives before the page subscribes, for the first subscriber only", () => {
    const { exposed, ipc } = probe("preload.ts", "https:");
    const auth = exposed.get("__chatDesktop")!.auth as DesktopAuth;
    const electronEvent = { sender: { privileged: true } };
    ipc.emit(SIGN_IN_TICKET, electronEvent, "EARLY");
    const first = vi.fn();
    auth.onTicket(first);
    expect(first).toHaveBeenCalledExactlyOnceWith("EARLY");
    const second = vi.fn();
    auth.onTicket(second);
    expect(second).not.toHaveBeenCalled();
  });

  it("gives a local recovery document read-only chrome and parameterless retry and chooser calls", async () => {
    const { exposed, ipc } = probe("preload.ts", "file:");
    expect(exposed.has("__chatDesktop")).toBe(false);
    const recovery = exposed.get("__chatRecovery")!;
    expect(Object.keys(recovery).toSorted()).toEqual([
      "canChangeServer",
      "changeServer",
      "chrome",
      "retry",
    ]);
    expect(recovery.canChangeServer).toBe(true);
    expect(recovery.chrome).not.toHaveProperty("setTheme");
    expect(recovery.chrome).not.toHaveProperty("request");
    const retry = recovery.retry as () => Promise<void>;
    await retry();
    expect(ipc.invoke).toHaveBeenLastCalledWith(RECOVERY_RETRY);
    const changeServer = recovery.changeServer as () => Promise<unknown>;
    await changeServer();
    expect(ipc.invoke).toHaveBeenLastCalledWith(CHANGE_SERVER);
  });

  it("keeps the connect preload isolated from recovery and Work authority", async () => {
    const { exposed, ipc } = probe("connect-preload.ts", "file:");
    expect([...exposed.keys()]).toEqual(["__chatConnect"]);
    const connect = exposed.get("__chatConnect")!;
    expect(Object.keys(connect).toSorted()).toEqual(["chrome", "connect", "current"]);
    expect(connect.chrome).not.toHaveProperty("setTheme");
    expect(connect.chrome).not.toHaveProperty("request");
    await (connect.current as () => Promise<unknown>)();
    expect(ipc.invoke).toHaveBeenLastCalledWith(CONNECT_CURRENT);
    await (connect.connect as (url: string) => Promise<unknown>)("chat.example.com");
    expect(ipc.invoke).toHaveBeenLastCalledWith(CONNECT, "chat.example.com");
  });
});
