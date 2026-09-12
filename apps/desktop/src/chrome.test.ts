import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { DesktopTheme } from "@chat/desktop-rpc";
import { attachChrome, chromeOptions, CHROME_STATE, isPageSender } from "./chrome.ts";
import { toOrigin } from "./config.ts";

const fixture = () => {
  let fullscreen = false;
  let destroyed = false;
  let systemDark = false;
  const window = Object.assign(new EventEmitter(), {
    isFullScreen: () => fullscreen,
    isDestroyed: () => destroyed,
    setBackgroundColor: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
  });
  const theme = Object.assign(new EventEmitter(), { themeSource: "system" as DesktopTheme });
  const nativeTheme = Object.assign(theme, { shouldUseDarkColors: false });
  Object.defineProperty(nativeTheme, "shouldUseDarkColors", {
    get: () => theme.themeSource === "dark" || (theme.themeSource === "system" && systemDark),
  });
  return {
    window,
    nativeTheme,
    setFullscreen: (value: boolean) => {
      fullscreen = value;
    },
    setSystemDark: (value: boolean) => {
      systemDark = value;
      theme.emit("updated");
    },
    close: () => {
      destroyed = true;
      window.emit("closed");
    },
  };
};

describe("native window chrome", () => {
  it.each(["darwin", "win32", "linux"] as const)("keeps native controls on %s", (platform) => {
    for (const dark of [false, true]) {
      const options = chromeOptions(platform, dark);
      expect(options.backgroundColor).toBe(dark ? "#0a0a0a" : "#ffffff");
      expect(options.autoHideMenuBar).toBe(platform !== "darwin");
      expect(options).not.toHaveProperty("frame", false);
      if (platform === "darwin") {
        expect(options).toMatchObject({
          titleBarStyle: "hiddenInset",
          titleBarOverlay: true,
          trafficLightPosition: { x: 16, y: 17 },
        });
      } else {
        expect(options).toMatchObject({
          titleBarStyle: "hidden",
          titleBarOverlay: {
            height: 48,
            color: options.backgroundColor,
            symbolColor: dark ? "#fafafa" : "#0a0a0a",
          },
        });
      }
    }
  });

  it("applies explicit themes and follows OS changes only in system mode", () => {
    const { window, nativeTheme, setSystemDark, close } = fixture();
    const chrome = attachChrome(window, nativeTheme, "win32");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    setSystemDark(true);
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({
      color: "#0a0a0a",
      symbolColor: "#fafafa",
      height: 48,
    });
    chrome.setTheme("light");
    setSystemDark(true);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    chrome.setTheme("dark");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#0a0a0a");
    chrome.setTheme("system");
    setSystemDark(false);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    const calls = window.setBackgroundColor.mock.calls.length;
    close();
    expect(nativeTheme.listenerCount("updated")).toBe(0);
    setSystemDark(true);
    expect(window.setBackgroundColor).toHaveBeenCalledTimes(calls);
  });

  it("keeps macOS controls native while updating its window background", () => {
    const { window, nativeTheme } = fixture();
    attachChrome(window, nativeTheme, "darwin").setTheme("dark");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#0a0a0a");
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it.each([null, undefined, "auto", "#ffffff", { color: "red" }, 1])(
    "rejects theme payload %j",
    (payload) => {
      const { window, nativeTheme } = fixture();
      const chrome = attachChrome(window, nativeTheme, "linux");
      expect(() => chrome.setTheme(payload)).toThrow("Invalid desktop theme");
      expect(nativeTheme.themeSource).toBe("system");
    },
  );

  it("combines native and HTML fullscreen, including state reads after reload", () => {
    const { window, nativeTheme, setFullscreen } = fixture();
    const chrome = attachChrome(window, nativeTheme, "darwin");
    expect(chrome.getState()).toEqual({ fullscreen: false });
    window.emit("enter-html-full-screen");
    expect(window.webContents.send).toHaveBeenLastCalledWith(CHROME_STATE, { fullscreen: true });
    setFullscreen(true);
    window.emit("enter-full-screen");
    window.emit("leave-html-full-screen");
    expect(chrome.getState()).toEqual({ fullscreen: true });
    window.webContents.emit("did-navigate");
    expect(chrome.getState()).toEqual({ fullscreen: true });
    setFullscreen(false);
    window.emit("leave-full-screen");
    expect(window.webContents.send).toHaveBeenLastCalledWith(CHROME_STATE, { fullscreen: false });
    window.emit("enter-html-full-screen");
    window.webContents.emit("did-navigate");
    expect(chrome.getState()).toEqual({ fullscreen: false });
  });
});

describe("presentation sender policy", () => {
  const remote = "https://chat.example.com";
  const local = "file:///app/static/connect.html";
  const allowedRemote = (url: string) => toOrigin(url) === remote;
  const allowedLocal = (url: string) => url === local;

  it("requires the actual window, main frame and configured origin", () => {
    const mainFrame = { url: `${remote}/chat/123` };
    const sender = { mainFrame };
    expect(isPageSender({ sender, senderFrame: mainFrame }, sender, allowedRemote)).toBe(true);
    expect(isPageSender({ sender, senderFrame: { ...mainFrame } }, sender, allowedRemote)).toBe(
      false,
    );
    expect(isPageSender({ sender, senderFrame: mainFrame }, { mainFrame }, allowedRemote)).toBe(
      false,
    );
    expect(isPageSender({ sender, senderFrame: null }, sender, allowedRemote)).toBe(false);
    expect(isPageSender({ sender, senderFrame: mainFrame }, undefined, allowedRemote)).toBe(false);
    mainFrame.url = "https://other.example.com";
    expect(isPageSender({ sender, senderFrame: mainFrame }, sender, allowedRemote)).toBe(false);
  });

  it("local authority requires the exact bundled file, not merely file protocol", () => {
    const mainFrame = { url: local };
    const sender = { mainFrame };
    expect(isPageSender({ sender, senderFrame: mainFrame }, sender, allowedLocal)).toBe(true);
    expect(isPageSender({ sender, senderFrame: { ...mainFrame } }, sender, allowedLocal)).toBe(
      false,
    );
    for (const url of [
      `${local}?redirect=1`,
      `${local}#fragment`,
      "file:///tmp/connect.html",
      remote,
    ]) {
      mainFrame.url = url;
      expect(isPageSender({ sender, senderFrame: mainFrame }, sender, allowedLocal)).toBe(false);
    }
  });
});
