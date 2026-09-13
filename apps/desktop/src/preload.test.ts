import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type DesktopAuth, type DesktopChrome } from "@chat/desktop-rpc";
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
  it("exposes optional chrome without changing Work protocol or leaking Electron events", async () => {
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
    expect(ipc.listenerCount(SIGN_IN_TICKET)).toBe(0);
    ipc.emit(SIGN_IN_TICKET, electronEvent, "again");
    expect(listener).toHaveBeenCalledTimes(1);
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
