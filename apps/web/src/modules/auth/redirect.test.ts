import { describe, expect, it } from "vitest";
import { safeRedirect } from "./redirect.ts";

describe("safeRedirect", () => {
  it("keeps a path on this origin, with its query", () => {
    expect(safeRedirect("/desktop/sign-in?challenge=abc_-")).toBe(
      "/desktop/sign-in?challenge=abc_-",
    );
    expect(safeRedirect("/")).toBe("/");
    expect(safeRedirect("/settings/devices#add")).toBe("/settings/devices#add");
  });

  it("rejects anything that could leave the origin", () => {
    for (const value of [
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "settings",
      "",
      "/a b",
      "/a\nb",
      "/ ",
      42,
      null,
      undefined,
    ])
      expect(safeRedirect(value), String(value)).toBeUndefined();
  });

  it("rejects an unreasonably long value", () => {
    expect(safeRedirect("/" + "a".repeat(2048))).toBeUndefined();
  });
});
