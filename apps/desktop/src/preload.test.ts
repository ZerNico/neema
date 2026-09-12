import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { DesktopChrome } from "@chat/desktop-rpc";
import { CHROME_GET_STATE, CHROME_SET_THEME, CHROME_STATE, RECOVERY_RETRY } from "./chrome.ts";

const probe = (entry: "preload.ts" | "connect-preload.ts", protocol: string) => {
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
    invoke: vi.fn(async () => ({ fullscreen: true })),
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
    process: { platform: "darwin" },
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
    expect(bridge.protocolVersion).toBe(3);
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

  it("gives a local recovery document only read-only chrome and a parameterless retry", async () => {
    const { exposed, ipc } = probe("preload.ts", "file:");
    expect(exposed.has("__chatDesktop")).toBe(false);
    const recovery = exposed.get("__chatRecovery")!;
    expect(Object.keys(recovery).toSorted()).toEqual(["chrome", "retry"]);
    expect(recovery.chrome).not.toHaveProperty("setTheme");
    expect(recovery.chrome).not.toHaveProperty("request");
    const retry = recovery.retry as () => Promise<void>;
    await retry();
    expect(ipc.invoke).toHaveBeenLastCalledWith(RECOVERY_RETRY);
  });

  it("keeps the connect preload isolated from recovery and Work authority", () => {
    const { exposed } = probe("connect-preload.ts", "file:");
    expect([...exposed.keys()]).toEqual(["__chatConnect"]);
    const connect = exposed.get("__chatConnect")!;
    expect(Object.keys(connect).toSorted()).toEqual(["chrome", "connect"]);
    expect(connect.chrome).not.toHaveProperty("setTheme");
    expect(connect.chrome).not.toHaveProperty("request");
  });
});
