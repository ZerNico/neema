import { describe, expect, it } from "vitest";
import { exampleArguments } from "./schema-example.ts";

describe("exampleArguments", () => {
  it("fills every property with a typed placeholder and uses descriptions as hints", () => {
    const text = exampleArguments({
      type: "object",
      required: ["city"],
      properties: {
        city: { type: "string", description: "City name" },
        days: { type: "integer" },
        metric: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
    });
    expect(JSON.parse(text)).toEqual({ city: "City name", days: 0, metric: false, tags: [""] });
  });

  it("follows $defs and picks the first non-null branch of a union", () => {
    const text = exampleArguments({
      type: "object",
      properties: {
        unit: { anyOf: [{ $ref: "#/$defs/Unit" }, { type: "null" }] },
        nested: { $ref: "#/$defs/Point" },
      },
      $defs: {
        Unit: { type: "string", enum: ["metric", "imperial"] },
        Point: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
        },
      },
    });
    expect(JSON.parse(text)).toEqual({ unit: "metric", nested: { x: 0, y: 0 } });
  });

  it("stops on a self-referencing schema rather than recursing forever", () => {
    const text = exampleArguments({
      type: "object",
      properties: { child: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } },
      },
    });
    expect(JSON.parse(text)).toEqual({ child: { child: null } });
  });

  it("gives an empty object for a function without parameters", () => {
    expect(exampleArguments({ type: "object", properties: {} })).toBe("{}");
  });
});
