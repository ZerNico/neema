import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { LIVE_LIMITS, overLimits, sheetBytes } from "./limits.ts";
import { emptyDoc, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";

const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: 1, ops }, 1).doc;
const write = (row: number, v: string): SheetOp => ({
  op: "set",
  sh: "s1",
  cells: [{ r: `s1.r${row}`, c: "s1.c1", v }],
});

describe("a sheet's limits", () => {
  const small = { ...LIVE_LIMITS, cells: 2, bytes: 200_000 };

  it("measures a changed sheet again, though the one before it was measured", () => {
    const two = apply(emptyDoc(), write(1, "a"), write(2, "b"));
    expect(overLimits(two, small)).toBeNull();
    const three = apply(two, write(3, "c"));
    expect(overLimits(three, small)).toBe("more than 2 cells in use");
    // Back under, the earlier document still measures as it did.
    expect(overLimits(two, small)).toBeNull();
  });

  it("measures a sheet's bytes as its JSON, writing again only the rows an edit touched", () => {
    const empty = emptyDoc().sheet.s1!;
    expect(sheetBytes(empty)).toBe(JSON.stringify(empty).length);
    const one = apply(emptyDoc(), write(1, "a"));
    expect(sheetBytes(one.sheet.s1!)).toBe(JSON.stringify(one.sheet.s1).length);
    const many = apply(one, write(2, 'b "quoted"'), write(7, "ü"), write(1, "longer"));
    expect(sheetBytes(many.sheet.s1!)).toBe(JSON.stringify(many.sheet.s1).length);
    // The untouched row is the same object, so it is read from what was written before.
    const edited = apply(many, write(2, "c"));
    expect(edited.sheet.s1!.cells["s1.r7"]).toBe(many.sheet.s1!.cells["s1.r7"]);
    expect(sheetBytes(edited.sheet.s1!)).toBe(JSON.stringify(edited.sheet.s1).length);
  });

  it("counts pictures' bytes with the rest of the document", () => {
    const doc = apply(emptyDoc(), {
      op: "imagePut",
      id: "p1",
      image: {
        sheet: "s1",
        at: { r: "s1.r1", c: "s1.c1" },
        size: { width: 10, height: 10 },
        src: `data:image/png;base64,${"A".repeat(250_000)}`,
      },
    });
    expect(overLimits(doc, small)).toBe("a document too large to keep live");
    expect(overLimits(doc)).toBeNull();
  });
});
