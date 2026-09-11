import { afterEach, describe, expect, it, vi } from "vitest";
import { browserTimeZone } from "./time-zone.ts";

afterEach(() => vi.restoreAllMocks());

describe("browserTimeZone", () => {
  it("reads the current browser zone on each submission", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions");
    spy.mockReturnValue({ ...resolved, timeZone: "Europe/Berlin" });
    expect(browserTimeZone()).toBe("Europe/Berlin");
    spy.mockReturnValue({ ...resolved, timeZone: "America/New_York" });
    expect(browserTimeZone()).toBe("America/New_York");
  });

  it("falls back to UTC when timezone detection is unavailable", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(browserTimeZone()).toBe("UTC");
  });
});
