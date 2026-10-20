import { describe, expect, it } from "vitest";
import { listingEntries, normalizeSchema } from "./listing.ts";
import { argumentCheck } from "./validate.ts";

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

  it("keeps a property named like a keyword, and values exactly as written", () => {
    const literal = { $ref: "#/$defs/x", $comment: "part of the value" };
    const normalized = normalizeSchema({
      type: "object",
      properties: {
        definitions: { type: "string" },
        $id: { type: "string" },
        mode: { const: literal },
        kind: { enum: [literal, "plain"] },
        options: { type: "object", default: { $schema: "kept" }, examples: [{ $id: "kept" }] },
      },
      required: ["definitions"],
      $defs: { x: { type: "number" } },
    });
    expect(normalized).toEqual({
      schema: {
        type: "object",
        properties: {
          definitions: { type: "string" },
          $id: { type: "string" },
          mode: { const: literal },
          kind: { enum: [literal, "plain"] },
          options: { type: "object", default: { $schema: "kept" }, examples: [{ $id: "kept" }] },
        },
        required: ["definitions"],
      },
    });
  });

  it("shows the model every constraint, in the dialect providers read", () => {
    const normalized = normalizeSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        point: {
          type: "array",
          items: [{ type: "number" }, { type: "number" }],
          additionalItems: false,
        },
        owner: { $ref: "#/definitions/person", required: ["email"] },
      },
      dependencies: { definitions: ["companion"], card: { required: ["billing"] } },
      dependentRequired: { other: ["x"] },
      definitions: { person: { type: "object", required: ["name"] } },
    });
    expect(normalized).toEqual({
      schema: {
        type: "object",
        properties: {
          point: {
            type: "array",
            prefixItems: [{ type: "number" }, { type: "number" }],
            items: false,
          },
          owner: {
            allOf: [{ type: "object", required: ["name"] }, { required: ["email"] }],
          },
        },
        dependentRequired: { other: ["x"], definitions: ["companion"] },
        dependentSchemas: { card: { required: ["billing"] } },
      },
    });
    const check = argumentCheck(
      "draft-07-constraints",
      "schema" in normalized ? normalized.schema : {},
    );
    if ("error" in check) throw new Error(check.error);
    expect(check({ definitions: 1 }).valid).toBe(false);
    expect(check({ owner: { name: "a" } }).valid).toBe(false);
    expect(check({ owner: { name: "a", email: "b" }, point: [1, 2] }).valid).toBe(true);
    expect(check({ point: [1, 2, 3] }).valid).toBe(false);
  });

  it("shows the model a root reference's arguments, with the sibling's words", () => {
    // zod-to-json-schema with a name: MCP's root `type` sits beside the reference.
    expect(
      normalizeSchema({
        type: "object",
        $ref: "#/$defs/Args",
        $defs: {
          Args: {
            type: "object",
            properties: { where: { $ref: "#/$defs/Place", description: "Where to look" } },
            required: ["where"],
          },
          Place: { type: "string", description: "A place" },
        },
      }),
    ).toEqual({
      schema: {
        type: "object",
        properties: { where: { type: "string", description: "Where to look" } },
        required: ["where"],
      },
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

  it("keeps the server's order and drops duplicates and nameless tools", () => {
    const entries = listingEntries("mcp", tools, []);
    expect(entries.map((entry) => entry.mcpName)).toEqual(["search", "drop_table", "wide"]);
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

describe("a schema the argument check cannot compile", () => {
  it("is listed as one that cannot be offered", () => {
    const [entry] = listingEntries(
      "docs",
      [
        {
          name: "odd",
          inputSchema: { type: "object", properties: { q: { type: "string", pattern: "(" } } },
        },
      ],
      [],
    );
    expect(entry?.unsupported).toBe("Its input schema is not valid JSON Schema.");
  });
});

describe("an asynchronous schema", () => {
  it("is checked synchronously, so a wrong argument is refused", () => {
    const [entry] = listingEntries(
      "docs",
      [
        {
          name: "odd",
          inputSchema: {
            $async: true,
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      ],
      [],
    );
    expect(entry?.unsupported).toBeUndefined();
    const check = argumentCheck(entry!.fingerprint, entry!.inputSchema);
    expect("error" in check).toBe(false);
    if ("error" in check) return;
    expect(check({ q: 5 }).valid).toBe(false);
    expect(check({ q: "x" }).valid).toBe(true);
  });
});

describe("a schema that would sink a listing", () => {
  it("counts long argument names against the budget too", () => {
    const name = "n".repeat(50_000);
    expect(
      normalizeSchema({
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`p${index}`, { $ref: "#/$defs/wide" }]),
        ),
        $defs: { wide: { type: "object", properties: { [name]: { type: "string" } } } },
      }),
    ).toEqual({ error: "Its input schema is too complex to offer." });
  });

  it("refuses only the tool nested past reason, not its neighbours", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 5_000; i++) deep = { type: "object", properties: { x: deep } };
    const entries = listingEntries(
      "docs",
      [
        { name: "deep", inputSchema: deep },
        { name: "fine", inputSchema: { type: "object" } },
      ],
      [],
    );
    expect(entries.map((entry) => [entry.mcpName, Boolean(entry.unsupported)])).toEqual([
      ["deep", true],
      ["fine", false],
    ]);
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

  it("weighs long strings too, not only how many nodes they sit in", () => {
    // A megabyte copied by a few references each: few nodes, gigabytes of text.
    const defs: Record<string, unknown> = { d6: { type: "string", description: "x".repeat(1e6) } };
    for (let i = 5; i >= 0; i--)
      defs[`d${i}`] = {
        type: "object",
        properties: { a: { $ref: `#/$defs/d${i + 1}` }, b: { $ref: `#/$defs/d${i + 1}` } },
      };
    const started = performance.now();
    expect(
      normalizeSchema({ type: "object", properties: { r: { $ref: "#/$defs/d0" } }, $defs: defs }),
    ).toEqual({ error: "Its input schema is too complex to offer." });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
