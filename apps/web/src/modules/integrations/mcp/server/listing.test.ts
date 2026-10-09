import { describe, expect, it } from "vitest";
import { listingEntries, normalizeSchema } from "./listing.ts";

describe("input schemas", () => {
  it("inlines local references and drops what providers cannot use", () => {
    const normalized = normalizeSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { owner: { $ref: "#/$defs/person" }, tags: { type: "array" } },
      $defs: { person: { type: "object", properties: { email: { type: "string" } } } },
    });
    expect(normalized).toEqual({
      schema: {
        type: "object",
        properties: {
          owner: { type: "object", properties: { email: { type: "string" } } },
          tags: { type: "array" },
        },
      },
    });
  });

  it("opens a recursive or remote reference instead of handing the model a dangling one", () => {
    const normalized = normalizeSchema({
      type: "object",
      properties: {
        node: { $ref: "#/$defs/node" },
        remote: { $ref: "https://example.com/schema.json", description: "elsewhere" },
      },
      $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
    });
    expect("schema" in normalized && JSON.stringify(normalized.schema)).not.toContain("$ref");
    expect("schema" in normalized && normalized.schema.properties).toMatchObject({
      remote: { description: "elsewhere" },
    });
  });

  it("refuses what cannot be named arguments", () => {
    expect(normalizeSchema({ type: "string" })).toEqual({
      error: "It does not take named arguments.",
    });
    expect(normalizeSchema(undefined)).toEqual({ schema: { type: "object", properties: {} } });
  });
});

describe("listing entries", () => {
  const tools = [
    {
      name: "search",
      description: "Find things",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
    { name: "search", description: "a duplicate the server should not send" },
    { name: "drop_table", inputSchema: { type: "object", properties: {} } },
    { name: "wide", description: "x".repeat(3_000) },
    { description: "nameless" },
  ];

  it("keeps the server's order, drops duplicates and nameless tools, and starts everything off", () => {
    const entries = listingEntries("mcp", tools, []);
    expect(entries.map((entry) => entry.mcpName)).toEqual(["search", "drop_table", "wide"]);
    expect(entries.every((entry) => !entry.enabled)).toBe(true);
    expect(entries.map((entry) => entry.access)).toEqual(["read", "destructive", "destructive"]);
    expect(entries[1]!.title).toBe("Drop table");
    expect(entries[2]!.unsupported).toMatch(/longer than/);
  });

  it("fingerprints what the server said, ignoring key order", () => {
    const [first] = listingEntries(
      "mcp",
      [{ name: "a", inputSchema: { type: "object", properties: { x: {}, y: {} } } }],
      [],
    );
    const [reordered] = listingEntries(
      "mcp",
      [{ name: "a", inputSchema: { properties: { y: {}, x: {} }, type: "object" } }],
      [],
    );
    const [changed] = listingEntries(
      "mcp",
      [
        {
          name: "a",
          description: "new words",
          inputSchema: { type: "object", properties: { x: {}, y: {} } },
        },
      ],
      [],
    );
    expect(reordered!.fingerprint).toBe(first!.fingerprint);
    expect(changed!.fingerprint).not.toBe(first!.fingerprint);
  });
});

describe("a schema built to explode", () => {
  it("is refused quickly instead of expanded", () => {
    // Each definition names the next ten times: 10^8 nodes within the depth limit.
    const defs: Record<string, unknown> = { d8: { type: "string" } };
    for (let i = 7; i >= 0; i--)
      defs[`d${i}`] = {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 10 }, (_, k) => [`p${k}`, { $ref: `#/$defs/d${i + 1}` }]),
        ),
      };
    const started = performance.now();
    const normalized = normalizeSchema({
      type: "object",
      properties: { root: { $ref: "#/$defs/d0" } },
      $defs: defs,
    });
    expect(normalized).toEqual({ error: "Its input schema is too complex to offer." });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
