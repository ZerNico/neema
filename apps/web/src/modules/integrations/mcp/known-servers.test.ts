import { describe, expect, it } from "vitest";
import { mcpAdapter } from "./server/adapter.ts";
import { findKnownMcpServer, KNOWN_MCP_SERVERS, knownMcpServerAt } from "./known-servers.ts";

describe("known MCP servers", () => {
  it("each has its own id and host, and a setup the adapter accepts as given", () => {
    const hosts = KNOWN_MCP_SERVERS.map((server) => new URL(server.url).hostname);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(new Set(KNOWN_MCP_SERVERS.map((server) => server.id)).size).toBe(hosts.length);
    for (const server of KNOWN_MCP_SERVERS) {
      expect(server.url.startsWith("https://")).toBe(true);
      // Stored as given, so the exact-address match finds a saved preset again.
      expect(mcpAdapter.normalizeConfig({ url: server.url, ways: "oauth" })).toMatchObject({
        config: { url: server.url },
      });
    }
  });

  it("recognises a server by its host, whatever the path", () => {
    expect(knownMcpServerAt("https://mcp.trello.com/v1")?.id).toBe("trello");
    // An older SSE endpoint, or one typed by hand, is the same service.
    expect(knownMcpServerAt("https://MCP.atlassian.com/v1/sse")?.id).toBe("atlassian");
    expect(knownMcpServerAt("https://docs.mcp.cloudflare.com/mcp")).toBeNull();
    expect(knownMcpServerAt("https://mcp.example.com/mcp")).toBeNull();
    expect(knownMcpServerAt("not a url")).toBeNull();
    expect(knownMcpServerAt(undefined)).toBeNull();
    expect(findKnownMcpServer("linear")?.name).toBe("Linear");
    // Asana's retired V1 address is the same service, which now wants a registered app.
    expect(knownMcpServerAt("https://mcp.asana.com/sse")).toMatchObject({
      id: "asana",
      ownApp: true,
    });
    expect(findKnownMcpServer(null)).toBeNull();
  });
});
