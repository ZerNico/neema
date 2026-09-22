import { afterEach, expect, it, vi } from "vitest";
import { readDesktopChrome } from "./chrome.ts";
import { PROTOCOL_VERSION, readDesktopChannel } from "./bridge.ts";

afterEach(() => vi.unstubAllGlobals());

it("has no chrome in server rendering, browsers, or existing desktop shells", () => {
  expect(readDesktopChrome()).toBeNull();
  vi.stubGlobal("__chatDesktop", undefined);
  expect(readDesktopChrome()).toBeNull();
  const channel = {
    protocolVersion: PROTOCOL_VERSION,
    request: async () => ({ ok: true, value: null }),
    stageDroppedFile: async () => null,
  };
  vi.stubGlobal("__chatDesktop", channel);
  expect(readDesktopChrome()).toBeNull();
  expect(readDesktopChannel()).toBe(channel);
});

it.each(["darwin", "win32", "linux"])(
  "discovers %s chrome independently of Work version",
  (platform) => {
    const chrome = {
      platform,
      getState: async () => ({ fullscreen: false }),
      onState: () => () => {},
      setTheme: async () => {},
    };
    vi.stubGlobal("__chatDesktop", { protocolVersion: -1, chrome });
    expect(readDesktopChrome()).toBe(chrome);
    expect(readDesktopChannel()).toBeNull();
  },
);

it.each([
  null,
  "chrome",
  {},
  { platform: "darwin" },
  {
    platform: "unknown",
    getState() {},
    onState() {},
    setTheme() {},
  },
])("ignores malformed chrome (%j)", (chrome) => {
  vi.stubGlobal("__chatDesktop", { chrome });
  expect(readDesktopChrome()).toBeNull();
});
