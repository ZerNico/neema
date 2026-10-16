import { EN_US } from "@chat/sheet/locales";
import { expect, it } from "vitest";
import type { ConditionalFormat } from "./grid-model.ts";
import { conditionalLooks } from "./looks.ts";
import { testSheet } from "./test-sheet.ts";

const box = { r1: "r1", c1: "c1", r2: "r4", c2: "c1" };
const built = (rule: ConditionalFormat[]) =>
  testSheet({ A1: 25, A2: 50, A3: 0, A4: 100 }, { conditional: rule });

it("sizes bars between the stops the rule was saved with, not the range's own extent", () => {
  const { sheet, value } = built([
    {
      box,
      rule: {
        kind: "bar",
        color: "#638EC6",
        stops: [
          { type: "number", value: 0 },
          { type: "number", value: 200 },
        ],
      },
    },
  ]);
  const looks = conditionalLooks(sheet, value, EN_US);
  expect(looks.get("r1|c1")?.bar?.fraction).toBe(0.125);
  expect(looks.get("r2|c1")?.bar?.fraction).toBe(0.25);
  expect(looks.get("r4|c1")?.bar?.fraction).toBe(0.5);
});

it("puts a three-colour scale's middle at the 50th percentile by default", () => {
  const { sheet, value } = built([
    { box, rule: { kind: "scale", colors: ["#000000", "#808080", "#FFFFFF"] } },
  ]);
  const looks = conditionalLooks(sheet, value, EN_US);
  // The median of 0, 25, 50 and 100 is 37.5, not the midpoint 50.
  expect(looks.get("r3|c1")?.fill).toBe("#000000");
  expect(looks.get("r2|c1")?.fill).toBe("#999999");
  expect(looks.get("r4|c1")?.fill).toBe("#FFFFFF");
});
