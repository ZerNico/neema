import { describe, expect, it } from "vitest";
import type { McpGrant } from "~/modules/auth/server/mcp-access.ts";
import { mcpGate, principalOf } from "./auth.ts";

const resource = "https://chat.example/api/mcp";
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

const grant = (overrides: Partial<McpGrant> = {}): McpGrant => ({
  userId: "user-1",
  clientId: "client-1",
  scopes: ["chats:read"],
  audience: [resource],
  expiresAt: inAnHour(),
  ...overrides,
});

const request = (token = "token") =>
  new Request(resource, { method: "POST", headers: { authorization: `Bearer ${token}` } });

const gate = (found: McpGrant | null, allowed = true) =>
  mcpGate({ resource, grantFor: async () => found, allowed: async () => allowed });

const status = (result: unknown) => (result instanceof Response ? result.status : 200);

describe("mcpGate", () => {
  it("lets a live grant for this endpoint through, naming its person", async () => {
    const result = await gate(grant())(request());
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(principalOf(result)).toEqual({
      userId: "user-1",
      clientId: "client-1",
      scopes: new Set(["chats:read"]),
    });
  });

  it("refuses a token bound to no resource or to another one", async () => {
    expect(status(await gate(grant({ audience: [] }))(request()))).toBe(401);
    expect(status(await gate(grant({ audience: ["https://other.example/mcp"] }))(request()))).toBe(
      401,
    );
  });

  it("refuses an unknown token, and an expired one", async () => {
    expect(status(await gate(null)(request()))).toBe(401);
    const expired = await gate(grant({ expiresAt: Math.floor(Date.now() / 1000) - 1 }))(request());
    expect(status(expired)).toBe(401);
  });

  it("refuses a valid token once the account may not connect apps", async () => {
    const result = await gate(grant(), false)(request());
    expect(status(result)).toBe(401);
    if (result instanceof Response) {
      expect(result.headers.get("www-authenticate")).toContain("resource_metadata=");
    }
  });

  it("refuses a request without a bearer header", async () => {
    const result = await gate(grant())(new Request(resource, { method: "POST" }));
    expect(status(result)).toBe(401);
  });
});
