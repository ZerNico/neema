import { describe, expect, it } from "vitest";
import { PRESENTATION_LIMITS } from "./limits.ts";
import { parsePresentationOperations } from "./operations.ts";

describe("presentation operation batches", () => {
  it("reports an oversized batch’s count without applying edits", () => {
    const count = PRESENTATION_LIMITS.operationsPerCall + 1;
    expect(() =>
      parsePresentationOperations(
        Array.from({ length: count }, () => ({ kind: "addSlide", layoutId: "Blank" })),
      ),
    ).toThrow(new RegExp(`received ${count} operations.*no edits were applied`));
  });

  it("names a pie chart given two series when the type is stated", () => {
    expect(() =>
      parsePresentationOperations([
        {
          kind: "addChart",
          slideId: 256,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          chartType: "pie",
          categories: ["A"],
          series: [
            { name: "One", values: [1] },
            { name: "Two", values: [2] },
          ],
        },
      ]),
    ).toThrow(/operations\[0\] addChart: pie charts take exactly one series/);
  });

  it("lets a decorative shape bleed past the slide edge, within a bound", () => {
    const shape = (y: number) => [
      { kind: "addShape", slideId: 256, shape: "ellipse", x: -40, y, width: 300, height: 300 },
    ];
    expect(parsePresentationOperations(shape(-100))).toHaveLength(1);
    expect(() => parsePresentationOperations(shape(-5000))).toThrow(/addShape\.y/);
  });
});
