import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { DesktopTheme, NoPayload } from "@chat/desktop-rpc";
import { pageHandler } from "./page-ipc.ts";

const Choice = Schema.Struct({ socket: Schema.NullOr(Schema.String) });
const page = { fromPage: true };
const elsewhere = { fromPage: false };
const allowed = (event: { fromPage: boolean }) => event.fromPage;

describe("pageHandler", () => {
  it("refuses another sender before decoding or running", () => {
    const run = vi.fn();
    const handle = pageHandler(allowed, NoPayload, run);
    expect(() => handle(elsewhere)).toThrow("Not allowed from this page.");
    expect(run).not.toHaveBeenCalled();
  });

  it("hands run the decoded payload", () => {
    expect(pageHandler(allowed, DesktopTheme, (theme) => theme)(page, "dark")).toBe("dark");
    expect(pageHandler(allowed, NoPayload, () => "ran")(page)).toBe("ran");
    expect(pageHandler(allowed, Choice, ({ socket }) => socket)(page, { socket: null })).toBeNull();
  });

  it("refuses a payload outside the schema with the channel's message", () => {
    const run = vi.fn();
    const handle = pageHandler(allowed, DesktopTheme, run, "Invalid theme.");
    for (const payload of [undefined, "blue", 1, { theme: "dark" }])
      expect(() => handle(page, payload)).toThrow("Invalid theme.");
    expect(() => pageHandler(allowed, Choice, run)(page, {})).toThrow("Malformed request.");
    expect(() => pageHandler(allowed, NoPayload, run)(page, { extra: true })).toThrow(
      "Malformed request.",
    );
    expect(run).not.toHaveBeenCalled();
  });
});
