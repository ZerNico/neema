import { afterEach, expect, it, vi } from "vitest";
import { readDesktopAuth } from "./auth.ts";
import { PROTOCOL_VERSION, readDesktopChannel } from "./bridge.ts";

afterEach(() => vi.unstubAllGlobals());

it("has no auth in server rendering, browsers, or existing desktop shells", () => {
  expect(readDesktopAuth()).toBeNull();
  vi.stubGlobal("__chatDesktop", undefined);
  expect(readDesktopAuth()).toBeNull();
  const channel = {
    protocolVersion: PROTOCOL_VERSION,
    request: async () => ({ ok: true, value: null }),
    stageDroppedFile: async () => null,
  };
  vi.stubGlobal("__chatDesktop", channel);
  expect(readDesktopAuth()).toBeNull();
  expect(readDesktopChannel()).toBe(channel);
});

it("discovers auth independently of Work version", () => {
  const auth = { onTicket: () => () => {}, canChangeServer: true, changeServer: async () => {} };
  vi.stubGlobal("__chatDesktop", { protocolVersion: -1, auth });
  expect(readDesktopAuth()).toBe(auth);
  expect(readDesktopChannel()).toBeNull();
});

it.each([
  null,
  "auth",
  {},
  { onTicket: "later" },
  { onTicket: () => () => {} },
  { changeServer: async () => {} },
  { onTicket: () => () => {}, changeServer: async () => {} },
  { onTicket: () => () => {}, changeServer: async () => {}, canChangeServer: "yes" },
])("ignores malformed auth (%j)", (auth) => {
  vi.stubGlobal("__chatDesktop", { auth });
  expect(readDesktopAuth()).toBeNull();
});
