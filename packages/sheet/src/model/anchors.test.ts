import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { invertChange } from "./invert.ts";
import { emptyDoc, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";

let revision = 0;
const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const box = (r1: number, c1: number, r2 = r1, c2 = c1) => ({
  r1: `s1.r${r1}`,
  r2: `s1.r${r2}`,
  c1: `s1.c${c1}`,
  c2: `s1.c${c2}`,
});
const threads = apply(
  emptyDoc(),
  { op: "set", sh: "s1", cells: [{ r: "s1.r1", c: "s1.c1", v: "Tea" }] },
  { op: "anchor", thread: "one", at: { sh: "s1", r: "s1.r1", c: "s1.c1" } },
  // A range across the cut's edge: only part of it moves.
  {
    op: "anchor",
    thread: "edge",
    at: { sh: "s1", r: "s1.r1", c: "s1.c1", r2: "s1.r5", c2: "s1.c1" },
  },
  { op: "anchor", thread: "away", at: { sh: "s1", r: "s1.r9", c: "s1.c9" } },
);

describe("threads on moving cells", () => {
  it("go with cut cells, leaving a range only partly cut, and come back on undo", () => {
    const moved = apply(threads, {
      op: "move",
      sh: "s1",
      box: box(1, 1, 2, 2),
      to: { r: "s1.r4", c: "s1.c3" },
    });
    expect(moved.anchors.one).toEqual({ sh: "s1", r: "s1.r4", c: "s1.c3" });
    expect(moved.anchors.edge).toEqual(threads.anchors.edge);
    expect(moved.anchors.away).toBe(threads.anchors.away);
    const undone = apply(moved, ...invertChange(threads, moved));
    expect(undone.anchors).toEqual(threads.anchors);
  });

  it("go with cut cells to another sheet", () => {
    const two = apply(threads, {
      op: "sheetAdd",
      id: "s2",
      name: "Two",
      after: "s1",
      rows: ["q1", "q2"],
      cols: ["k1", "k2"],
    });
    const moved = apply(two, {
      op: "move",
      sh: "s1",
      box: box(1, 1),
      to: { sh: "s2", r: "q2", c: "k2" },
    });
    expect(moved.anchors.one).toEqual({ sh: "s2", r: "q2", c: "k2" });
  });

  it("follow a row's contents through a sort, but not a range over several rows", () => {
    const sorted = apply(threads, {
      op: "sort",
      sh: "s1",
      c1: "s1.c1",
      c2: "s1.c1",
      rows: ["s1.r1", "s1.r2", "s1.r3"],
      order: ["s1.r3", "s1.r1", "s1.r2"],
    });
    // Row 1's contents went to row 2.
    expect(sorted.anchors.one).toEqual({ sh: "s1", r: "s1.r2", c: "s1.c1" });
    expect(sorted.anchors.edge).toEqual(threads.anchors.edge);
  });

  it("move a chart or picture off a deleted row to the next live one, and back on undo", () => {
    const placed = apply(
      emptyDoc(),
      {
        op: "chartPut",
        id: "ch",
        chart: {
          sheet: "s1",
          at: { r: "s1.r2", c: "s1.c2" },
          size: { width: 400, height: 300 },
          kind: "column",
          series: [{ values: box(5, 1, 8, 1) }],
        },
      },
      {
        op: "imagePut",
        id: "p1",
        image: {
          sheet: "s1",
          at: { r: "s1.r2", c: "s1.c3" },
          size: { width: 10, height: 10 },
          src: "data:image/png;base64,AAAA",
        },
      },
    );
    const deleted = apply(placed, {
      op: "delete",
      sh: "s1",
      axis: "rows",
      ids: ["s1.r2", "s1.r3"],
    });
    expect(deleted.charts.ch!.at).toEqual({ r: "s1.r4", c: "s1.c2" });
    expect(deleted.images!.p1!.at).toEqual({ r: "s1.r4", c: "s1.c3" });
    const undone = apply(deleted, ...invertChange(placed, deleted));
    expect([undone.charts.ch!.at, undone.images!.p1!.at]).toEqual([
      placed.charts.ch!.at,
      placed.images!.p1!.at,
    ]);
  });

  it("place a picture put on a row deleted meanwhile on the next one, and never on unknown cells", () => {
    const image = {
      sheet: "s1",
      at: { r: "s1.r2", c: "s1.c2" },
      size: { width: 20, height: 20 },
      src: "data:image/png;base64,AAAA",
    };
    // Someone deleted row 2 just before the picture arrived.
    const deleted = apply(emptyDoc(), { op: "delete", sh: "s1", axis: "rows", ids: ["s1.r2"] });
    const placed = apply(deleted, { op: "imagePut", id: "p1", image });
    expect(placed.images!.p1!.at).toEqual({ r: "s1.r3", c: "s1.c2" });
    const nowhere = apply(emptyDoc(), {
      op: "imagePut",
      id: "p1",
      image: { ...image, at: { r: "zz.r1", c: "s1.c1" } },
    });
    expect(nowhere.images).toBeUndefined();
  });
});
