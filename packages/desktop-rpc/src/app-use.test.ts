import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { AppUsePlace, readDesktopAppUse, type DesktopAppUse } from "./app-use.ts";

const appUse = {
  state: async () => null,
  onUpdate: () => () => {},
  onOpenChat: () => () => {},
  pause: async () => {},
  place: async () => {},
} satisfies DesktopAppUse;

afterEach(() => vi.unstubAllGlobals());

it("reads the live view a Mac shell exposes, and nothing from a page without one", () => {
  vi.stubGlobal("__chatDesktop", { appUse });
  expect(readDesktopAppUse()).toBe(appUse);
  vi.stubGlobal("__chatDesktop", { appUse: { ...appUse, place: undefined } });
  expect(readDesktopAppUse()).toBeNull();
  vi.stubGlobal("__chatDesktop", {});
  expect(readDesktopAppUse()).toBeNull();
});

it("decodes only the placements there are", () => {
  const decode = Schema.decodeUnknownSync(AppUsePlace);
  expect(decode({ conversationId: "c1", placement: "floating" })).toEqual({
    conversationId: "c1",
    placement: "floating",
  });
  expect(() => decode({ conversationId: "c1", placement: "dock" })).toThrow(
    'Expected "panel" | "floating"',
  );
  expect(() => decode({ conversationId: "", placement: "panel" })).toThrow(
    "Expected a value with a length of at least 1",
  );
});
