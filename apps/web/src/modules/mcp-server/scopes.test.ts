import { describe, expect, it } from "vitest";
import { accessSummary, MCP_SCOPES } from "./scopes.ts";

describe("accessSummary", () => {
  it("calls every scope full access", () => {
    expect(accessSummary([...MCP_SCOPES, "offline_access"])).toBe("Full access");
  });

  it("names what an app changes before what it only sees, each area once", () => {
    expect(
      accessSummary([
        "chats:read",
        "chats:write",
        "documents:write",
        "knowledge:read",
        "skills:read",
      ]),
    ).toBe("Can change chats and documents, can see knowledge and skills");
  });

  it("reads a read-only grant", () => {
    expect(accessSummary(["chats:read", "memory:read"])).toBe("Can see chats and memory");
  });
});
