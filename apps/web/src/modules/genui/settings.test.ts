import { describe, expect, it } from "vitest";
import { readInteractiveUi } from "./settings.ts";

describe("readInteractiveUi", () => {
  it("defaults to on when the row is missing", () => {
    expect(readInteractiveUi(null)).toEqual({ enabled: true, images: true });
  });

  it("keeps images on unless switched off", () => {
    expect(readInteractiveUi({ enabled: true, config: {} })).toEqual({
      enabled: true,
      images: true,
    });
    expect(readInteractiveUi({ enabled: true, config: { images: false } })).toEqual({
      enabled: true,
      images: false,
    });
  });

  it("turns images off with the whole feature", () => {
    expect(readInteractiveUi({ enabled: false, config: { images: true } })).toEqual({
      enabled: false,
      images: false,
    });
  });
});
