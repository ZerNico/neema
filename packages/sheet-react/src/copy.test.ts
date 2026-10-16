import { EN_US } from "@chat/sheet/locales";
import { expect, it } from "vitest";
import { selectionText } from "./copy.ts";
import { at, testSheet } from "./test-sheet.ts";

const copy = (built: ReturnType<typeof testSheet>, from: [number, number], to: [number, number]) =>
  selectionText(built.sheet, built.value, EN_US, { anchor: at(...from), head: at(...to) });

it("copies cells as shown, quoting a tab, a line break or a quote as Excel does", () => {
  const built = testSheet({ A1: "a\nb", B1: 'say "hi"', A2: 0.5, B2: "x\ty" });
  expect(copy(built, [1, 1], [2, 2])).toBe('"a\nb"\t"say ""hi"""\n0.5\t"x\ty"');
});

it("drops empty trailing rows and columns and hidden ones, but keeps inner gaps", () => {
  const built = testSheet({ A1: 1, C1: 3, A3: "end" }, { rowProps: { r2: { hidden: true } } });
  expect(copy(built, [1, 1], [1000, 26])).toBe("1\t\t3\nend\t\t");
  expect(copy(built, [5, 5], [5, 5])).toBe("");
});

it("refuses a range over its budget instead of reading every cell", () => {
  const built = testSheet({}, { rows: 1_048_576, cols: 16_384 });
  expect(copy(built, [1, 1], [1_048_576, 16_384])).toBeNull();
});
