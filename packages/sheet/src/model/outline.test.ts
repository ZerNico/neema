import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { invertChange } from "./invert.ts";
import { emptyDoc, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";
import { collapsedIds, isOutlineList, outlineDepth, placeGroups } from "./outline.ts";

let revision = 0;
const apply = (doc: SheetDoc, ops: readonly SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;

describe("grouped rows and columns", () => {
  it("nests groups into levels by what contains what", () => {
    const doc = apply(emptyDoc(), [
      {
        op: "outline",
        sh: "s1",
        axis: "rows",
        list: [
          { from: "s1.r3", to: "s1.r4" },
          { from: "s1.r2", to: "s1.r9" },
          { from: "s1.r6", to: "s1.r7", collapsed: true },
        ],
      },
    ]);
    const placed = placeGroups(doc.sheet.s1!.rows, doc.sheet.s1!.outline!.rows);
    expect(placed.map((each) => [each.start, each.end, each.level])).toEqual([
      [2, 9, 1],
      [3, 4, 2],
      [6, 7, 2],
    ]);
    expect(outlineDepth(placed)).toBe(2);
    expect([...collapsedIds(doc, "s1", "rows")]).toEqual(["s1.r6", "s1.r7"]);
    expect(isOutlineList([{ from: "a", to: "b", hidden: true }])).toBe(false);
  });

  it("undoes a change of groups, and moves a group's deleted end inward", () => {
    const doc = apply(emptyDoc(), [
      { op: "outline", sh: "s1", axis: "columns", list: [{ from: "s1.c2", to: "s1.c4" }] },
    ]);
    const after = apply(doc, [
      { op: "outline", sh: "s1", axis: "columns", list: [] },
      { op: "outline", sh: "s1", axis: "rows", list: [{ from: "s1.r1", to: "s1.r2" }] },
    ]);
    expect(after.sheet.s1!.outline).toEqual({ rows: [{ from: "s1.r1", to: "s1.r2" }] });
    expect(apply(after, invertChange(doc, after)).sheet.s1!.outline).toEqual(doc.sheet.s1!.outline);
    const deleted = apply(doc, [{ op: "delete", sh: "s1", axis: "columns", ids: ["s1.c4"] }]);
    expect(deleted.sheet.s1!.outline!.cols).toEqual([{ from: "s1.c2", to: "s1.c3" }]);
  });
});
