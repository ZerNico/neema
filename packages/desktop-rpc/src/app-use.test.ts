import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { AppUsePause, readDesktopAppUse, type DesktopAppUse } from "./app-use.ts";

const appUse = {
  state: async () => null,
  onUpdate: () => () => {},
  pause: async () => {},
} satisfies DesktopAppUse;

afterEach(() => vi.unstubAllGlobals());

it("reads the live view a Mac shell exposes, and nothing from a page without one", () => {
  vi.stubGlobal("__chatDesktop", { appUse });
  expect(readDesktopAppUse()).toBe(appUse);
  vi.stubGlobal("__chatDesktop", { appUse: { ...appUse, pause: undefined } });
  expect(readDesktopAppUse()).toBeNull();
  vi.stubGlobal("__chatDesktop", {});
  expect(readDesktopAppUse()).toBeNull();
});

it("decodes a pause only for a named chat", () => {
  const decode = Schema.decodeUnknownSync(AppUsePause);
  expect(decode({ conversationId: "c1", paused: true })).toEqual({
    conversationId: "c1",
    paused: true,
  });
  expect(() => decode({ conversationId: "", paused: true })).toThrow(
    "Expected a value with a length of at least 1",
  );
});
