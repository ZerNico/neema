import { describe, expect, it } from "vitest";
import { mcpResourceFor } from "./resource.ts";

describe("mcpResourceFor", () => {
  it("binds tokens to the endpoint under an https address", () => {
    expect(mcpResourceFor("https://chat.example")).toBe("https://chat.example/api/mcp");
    expect(mcpResourceFor("https://chat.localhost:1355")).toBe(
      "https://chat.localhost:1355/api/mcp",
    );
  });

  it("allows plain http on loopback only", () => {
    expect(mcpResourceFor("http://localhost:3000")).toBe("http://localhost:3000/api/mcp");
    expect(mcpResourceFor("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/api/mcp");
    expect(mcpResourceFor("http://chat.lan")).toBeUndefined();
  });

  it("offers nothing without a usable address", () => {
    expect(mcpResourceFor(undefined)).toBeUndefined();
    expect(mcpResourceFor("not a url")).toBeUndefined();
    expect(mcpResourceFor("https://user:pass@chat.example")).toBeUndefined();
  });
});
