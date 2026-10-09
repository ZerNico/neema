import { describe, expect, it } from "vitest";
import { INTEGRATION_ID, integrationToolName } from "../manifest.ts";
import {
  accessFromAnnotations,
  applyDecisions,
  argumentDetails,
  assignKeys,
  diffCatalog,
  keyBudget,
  offeredEntries,
  summarizeArguments,
  type McpToolEntry,
} from "./catalog.ts";

const entry = (mcpName: string, patch: Partial<McpToolEntry> = {}): McpToolEntry => ({
  key: mcpName,
  mcpName,
  title: mcpName,
  description: `${mcpName} things`,
  inputSchema: { type: "object", properties: {} },
  annotations: {},
  access: "destructive",
  enabled: false,
  fingerprint: `${mcpName}-1`,
  ...patch,
});

describe("access from annotations", () => {
  it("trusts nothing a server leaves unsaid", () => {
    expect(accessFromAnnotations({})).toBe("destructive");
    expect(accessFromAnnotations({ readOnlyHint: false })).toBe("destructive");
    expect(accessFromAnnotations({ destructiveHint: false })).toBe("write");
    expect(accessFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe("read");
  });
});

describe("model-facing keys", () => {
  it("keeps a clean name, cleans the rest and always fits 64 characters", () => {
    const id = "a".repeat(24);
    expect(INTEGRATION_ID.test(id)).toBe(true);
    const long = `search_${"x".repeat(80)}`;
    const keys = assignKeys(id, ["search", "get.page", "get/page", long], new Map());
    expect(keys.get("search")).toBe("search");
    // Two names that clean up alike stay apart.
    expect(keys.get("get.page")).toBe("get_page");
    expect(keys.get("get/page")).not.toBe("get_page");
    for (const key of keys.values()) {
      expect(key.length).toBeLessThanOrEqual(keyBudget(id));
      expect(integrationToolName(id, key)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
    expect(new Set(keys.values()).size).toBe(4);
  });

  it("never renames an approved tool, whatever the server lists beside it", () => {
    const keys = assignKeys("mcp", ["get_page", "get.page"], new Map([["get.page", "get_page"]]));
    expect(keys.get("get.page")).toBe("get_page");
    expect(keys.get("get_page")).not.toBe("get_page");
  });
});

describe("drift", () => {
  const approved = [
    entry("search", { enabled: true, access: "read", accessChosen: true }),
    entry("delete", { enabled: true }),
    entry("gone", { enabled: true }),
  ];
  const latest = [
    entry("search"),
    entry("delete", { fingerprint: "delete-2", description: "now also emails" }),
    entry("new_tool"),
  ];

  it("names what was added, changed and removed", () => {
    expect(
      diffCatalog(approved, latest).map((change) => [
        change.kind,
        ("entry" in change ? change.entry : change.before).mcpName,
      ]),
    ).toEqual([
      ["unchanged", "search"],
      ["changed", "delete"],
      ["added", "new_tool"],
      ["removed", "gone"],
    ]);
  });

  it("offers only approved tools the server still lists unchanged", () => {
    expect(offeredEntries(approved, latest).map((tool) => tool.mcpName)).toEqual(["search"]);
    // Before any listing, what was approved stands.
    expect(offeredEntries(approved, null).map((tool) => tool.mcpName)).toEqual([
      "search",
      "delete",
      "gone",
    ]);
  });

  it("never offers a tool that cannot be offered, even if it was turned on", () => {
    const broken = [
      entry("odd", { enabled: true, unsupported: "Its input schema is not an object." }),
    ];
    expect(offeredEntries(broken, broken)).toEqual([]);
  });

  it("applies a review to exactly the current listing, keeping the admin's own choices", () => {
    const next = applyDecisions(approved, latest, [
      { mcpName: "delete", enabled: true, access: "destructive" },
    ]);
    expect(next.map((tool) => [tool.mcpName, tool.enabled, tool.access])).toEqual([
      // Chosen before, so still read, still on.
      ["search", true, "read"],
      ["delete", true, "destructive"],
      // New and undecided: off.
      ["new_tool", false, "destructive"],
    ]);
    expect(next[0]!.accessChosen).toBe(true);
    expect(offeredEntries(next, latest).map((tool) => tool.mcpName)).toEqual(["search", "delete"]);
  });
});

describe("approval details", () => {
  it("lists every argument, bounded, and summarizes the first few", () => {
    const args = {
      query: "budget  2026",
      limit: 5,
      filters: { owner: "me" },
      body: "x".repeat(400),
    };
    const details = argumentDetails(args);
    expect(details.map((detail) => detail.key)).toEqual(["query", "limit", "filters", "body"]);
    expect(details[2]!.value).toBe('{"owner":"me"}');
    expect(details[3]!.value.length).toBeLessThanOrEqual(300);
    expect(summarizeArguments(args)).toBe(
      'query: budget 2026 · limit: 5 · filters: {"owner":"me"}',
    );
    expect(summarizeArguments({})).toBeNull();
  });
});
