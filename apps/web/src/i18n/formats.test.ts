import { describe, expect, it } from "vitest";
import { detectRegion, formatTag, regionIn, regionOf } from "./formats.ts";

describe("formatTag", () => {
  it("writes English the way any region does", () => {
    expect(formatTag("en", "DE")).toBe("en-DE");
    expect(formatTag("en", "GB")).toBe("en-GB");
    expect(formatTag("en", undefined)).toBe("en");
  });

  it("keeps German formats where German has no form for the region", () => {
    expect(formatTag("de", "CH")).toBe("de-CH");
    expect(formatTag("de", "US")).toBe("de");
  });
});

describe("detectRegion", () => {
  it("prefers the operating system, which the desktop app names", () => {
    expect(detectRegion("en", ["en-GB", "en-DE", "de-DE"], "en-DE")).toBe("DE");
  });

  it("takes the first browser language matching the page, else the first with a region", () => {
    expect(detectRegion("en", ["de-DE", "en-GB"])).toBe("GB");
    expect(detectRegion("en", ["de-AT", "en"])).toBe("AT");
    expect(detectRegion("de", ["de", "en"])).toBeUndefined();
  });
});

describe("regionIn and regionOf", () => {
  it("read only a well-formed region", () => {
    expect(regionIn("a=1; formats=GB; b=2")).toBe("GB");
    expect(regionIn("formats=gb")).toBeUndefined();
    expect(regionOf("en_DE")).toBe("DE");
    expect(regionOf("not a tag")).toBeUndefined();
  });
});
