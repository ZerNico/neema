import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { boundsOf, boxAt, contains, holds, overlaps, placeBox, withoutBounds } from "./box.ts";
import { emptyDoc } from "./model.ts";

const sheet = emptyDoc().sheet.s1!;

describe("ranges by IDs", () => {
  it("place with their corners in order, whichever way they were given", () => {
    const bounds = boundsOf(sheet, { r1: "s1.r4", r2: "s1.r2", c1: "s1.c3", c2: "s1.c1" });
    expect(bounds).toEqual({ top: 2, bottom: 4, left: 1, right: 3 });
    expect(boxAt(sheet, bounds!)).toEqual({ r1: "s1.r2", r2: "s1.r4", c1: "s1.c1", c2: "s1.c3" });
    expect(placeBox(sheet, boxAt(sheet, bounds!))?.cols).toEqual(["s1.c1", "s1.c2", "s1.c3"]);
  });

  it("cover nothing once a corner is deleted, and nothing on a missing sheet", () => {
    const doc = applyChange(
      emptyDoc(),
      { clientId: "t", seq: 1, ops: [{ op: "delete", sh: "s1", axis: "rows", ids: ["s1.r2"] }] },
      1,
    ).doc;
    expect(boundsOf(doc.sheet.s1, { r1: "s1.r2", r2: "s1.r5", c1: "s1.c1", c2: "s1.c1" })).toBe(
      null,
    );
    expect(placeBox(undefined, { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" })).toBe(null);
  });

  it("meet at a shared edge, and hold what lies inside", () => {
    const a = { top: 1, bottom: 3, left: 1, right: 3 };
    expect(overlaps(a, { top: 3, bottom: 5, left: 3, right: 5 })).toBe(true);
    expect(overlaps(a, { top: 4, bottom: 5, left: 1, right: 5 })).toBe(false);
    expect(contains(a, { top: 2, bottom: 3, left: 1, right: 2 })).toBe(true);
    expect(contains(a, { top: 2, bottom: 4, left: 1, right: 2 })).toBe(false);
    expect([holds(a, 3, 3), holds(a, 0, 1)]).toEqual([true, false]);
  });

  it("give up an area's cells, keeping the rest of each as up to four pieces", () => {
    const rule = { id: "v", box: { r1: "s1.r1", r2: "s1.r3", c1: "s1.c1", c2: "s1.c3" } };
    let minted = 0;
    const kept = withoutBounds(
      sheet,
      [rule],
      { top: 2, bottom: 2, left: 2, right: 2 },
      () => `n${++minted}`,
    );
    const corners = (each: typeof rule) =>
      `${each.box.r1}:${each.box.c1}-${each.box.r2}:${each.box.c2}`;
    expect(kept.map(corners)).toEqual([
      "s1.r1:s1.c1-s1.r1:s1.c3",
      "s1.r3:s1.c1-s1.r3:s1.c3",
      "s1.r2:s1.c1-s1.r2:s1.c1",
      "s1.r2:s1.c3-s1.r2:s1.c3",
    ]);
    expect(kept.map((each) => each.id)).toEqual(["v", "n1", "n2", "n3"]);
    // One wholly inside goes; one apart stays the same object.
    expect(
      withoutBounds(sheet, [rule], { top: 1, bottom: 5, left: 1, right: 5 }, () => "x"),
    ).toEqual([]);
    expect(
      withoutBounds(sheet, [rule], { top: 9, bottom: 9, left: 9, right: 9 }, () => "x")[0],
    ).toBe(rule);
  });
});
