import { describe, expect, it } from "vitest";
import { INTEGRATION_ID } from "../manifest.ts";
import { idFromName } from "./repo.ts";

describe("idFromName", () => {
  it("reads a name as a short lowercase id", () => {
    expect(idFromName("DeepWiki", "mcp")).toBe("deepwiki");
    expect(idFromName("  My Café Server! ", "mcp")).toBe("my-cafe-server");
  });

  it("falls back when nothing of the name is left", () => {
    expect(idFromName("🚀🚀", "mcp")).toBe("mcp");
  });

  it("never ends on a dash when cut", () => {
    expect(idFromName(`${"a".repeat(35)} b`, "mcp")).toBe("a".repeat(35));
  });

  it("always fits the id pattern, with room for a number", () => {
    expect(idFromName("3D Tools", "mcp")).toBe("mcp-3d-tools");
    for (const name of ["3D Tools", "x".repeat(80), "🚀", "Ab"])
      expect(INTEGRATION_ID.test(`${idFromName(name, "mcp")}-999`)).toBe(true);
  });
});
