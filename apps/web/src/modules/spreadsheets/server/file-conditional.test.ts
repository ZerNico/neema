import { expect, it } from "vitest";
import { readConditional } from "./file-conditional.ts";

const rule = (type: "colorScale" | "dataBar", innerXml: string) =>
  readConditional({ type, priority: 1, formulas: [], innerXml }, []);

it("keeps the stops a scale or bar was saved with, and leaves out one it cannot place", () => {
  expect(
    rule(
      "dataBar",
      '<dataBar><cfvo type="num" val="0"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar>',
    ),
  ).toEqual({
    kind: "bar",
    color: "#638EC6",
    stops: [{ type: "number", value: 0 }, { type: "max" }],
  });
  expect(
    rule(
      "colorScale",
      '<colorScale><cfvo type="min"/><cfvo type="percent" val="25"/><cfvo type="percentile" val="90"/>' +
        '<color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale>',
    ),
  ).toMatchObject({
    stops: [{ type: "min" }, { type: "percent", value: 25 }, { type: "percentile", value: 90 }],
  });
  expect(
    rule(
      "dataBar",
      '<dataBar><cfvo type="formula" val="$A$1"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar>',
    ),
  ).toBeNull();
});
