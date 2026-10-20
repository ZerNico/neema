import { describe, expect, it } from "vitest";
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
    expect(idFromName(`${"a".repeat(39)} b`, "mcp")).toBe("a".repeat(39));
  });
});
