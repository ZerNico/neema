import { describe, expect, it } from "vitest";
import { EN_US } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import { placeGroups } from "@chat/sheet/model/outline";
import type { SheetOp } from "@chat/sheet/model/ops";
import type { GridContext } from "./commands.ts";
import {
  groupSelection,
  outlineAxis,
  showLevel,
  toggleGroup,
  ungroupSelection,
} from "./outline-commands.ts";

let revision = 0;
const apply = (doc: SheetDoc, ops: readonly SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const context = (doc: SheetDoc, from: [number, number], to: [number, number]): GridContext => ({
  doc,
  sheet: "s1",
  selection: {
    anchor: { r: `s1.r${from[0]}`, c: `s1.c${from[1]}` },
    head: { r: `s1.r${to[0]}`, c: `s1.c${to[1]}` },
  },
  values: calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 }),
  locale: EN_US,
  mint: () => "n",
});
const groups = (doc: SheetDoc) => placeGroups(doc.sheet.s1!.rows, doc.sheet.s1!.outline?.rows);

describe("grouping", () => {
  it("groups a selection's rows inside another group, collapses, shows a level and ungroups", () => {
    let doc = apply(emptyDoc(), groupSelection(context(emptyDoc(), [2, 1], [9, 1]), "rows"));
    doc = apply(doc, groupSelection(context(doc, [3, 2], [4, 2]), "rows"));
    // The same span again adds nothing.
    expect(groupSelection(context(doc, [3, 1], [4, 1]), "rows")).toEqual([]);
    expect(groups(doc).map((each) => each.level)).toEqual([1, 2]);
    doc = apply(doc, toggleGroup(doc, "s1", "rows", groups(doc)[1]!));
    expect(doc.sheet.s1!.outline!.rows![1]).toMatchObject({ collapsed: true });
    doc = apply(doc, showLevel(doc, "s1", "rows", 1));
    expect(doc.sheet.s1!.outline!.rows!.every((each) => each.collapsed)).toBe(true);
    doc = apply(doc, showLevel(doc, "s1", "rows", 3));
    expect(doc.sheet.s1!.outline!.rows!.some((each) => each.collapsed)).toBe(false);
    // Ungroup takes the innermost group the selection touches.
    doc = apply(doc, ungroupSelection(context(doc, [4, 1], [4, 1]), "rows"));
    expect(groups(doc).map((each) => [each.start, each.end])).toEqual([[2, 9]]);
  });

  it("acts on columns when whole columns are selected", () => {
    const doc = emptyDoc();
    const rows = doc.sheet.s1!.rows.length;
    expect(outlineAxis(context(doc, [1, 2], [rows, 3]))).toBe("columns");
    expect(outlineAxis(context(doc, [2, 2], [5, 3]))).toBe("rows");
  });
});
