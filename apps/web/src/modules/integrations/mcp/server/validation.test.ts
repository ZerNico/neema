import { describe, expect, it } from "vitest";
import { argumentCheck } from "./validate.ts";
import { costlyPattern, validationSchema } from "./validation.ts";

describe("patterns", () => {
  it("tells a pattern that can backtrack for ever from an ordinary one", () => {
    for (const costly of ["^(a+)+$", "(a|aa)*", "((a+)b)+", "(\\w+\\s?)*$", "(x+x+)+y"])
      expect(costlyPattern(costly), costly).toBe(true);
    for (const fine of ["^[a-z]+$", "^\\d{3}-\\d{4}$", "(ab)+", "^(?:https?)://", "[(a+)+]"])
      expect(costlyPattern(fine), fine).toBe(false);
  });
});

describe("the schema arguments are checked against", () => {
  it("is the server's own, references and dialect as written", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        owner: { $ref: "#/definitions/person" },
        point: { items: [{ type: "number" }] },
      },
      definitions: { person: { type: "object", required: ["name"] } },
      additionalProperties: false,
    };
    expect(validationSchema(schema)).toEqual({ schema });
  });

  it("leaves out only what would make checking unsafe", () => {
    const kept = validationSchema({
      $async: true,
      type: "object",
      properties: {
        code: { type: "string", pattern: "^(a+)+$" },
        zip: { type: "string", pattern: "^\\d{5}$" },
        pattern: { type: "string" },
      },
    });
    expect(kept).toEqual({
      schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          zip: { type: "string", pattern: "^\\d{5}$" },
          pattern: { type: "string" },
        },
      },
    });
    if (!("schema" in kept)) return;
    const check = argumentCheck("validation-safe", kept.schema);
    if ("error" in check) throw new Error(check.error);
    const started = performance.now();
    expect(check({ code: `${"a".repeat(40)}!`, zip: "12345" }).valid).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
    expect(check({ zip: "1" }).valid).toBe(false);
  });

  it("refuses names matched by a costly pattern, and nesting with no end", () => {
    expect(
      validationSchema({ type: "object", patternProperties: { "^(a+)+$": { type: "string" } } }),
    ).toEqual({ error: "It names its arguments with a pattern too costly to check." });
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 100; i++) deep = { type: "object", properties: { x: deep } };
    expect(validationSchema(deep)).toEqual({ error: "Its input schema is nested too deeply." });
  });
});
