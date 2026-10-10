import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { isSheetImage, type SheetImage } from "./image.ts";
import { invertChange } from "./invert.ts";
import { emptyDoc, type SheetDoc } from "./model.ts";
import { parseChange, type SheetOp } from "./ops.ts";

let revision = 0;
const apply = (doc: SheetDoc, ops: readonly SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const picture: SheetImage = {
  sheet: "s1",
  at: { r: "s1.r2", c: "s1.c2" },
  size: { width: 200, height: 100 },
  src: "data:image/png;base64,iVBORw0KGgo=",
  alt: "Logo",
};

describe("pictures on a sheet", () => {
  it("puts, removes and undoes a picture, and refuses SVG", () => {
    const doc = apply(emptyDoc(), [{ op: "imagePut", id: "p1", image: picture }]);
    expect(doc.images).toEqual({ p1: picture });
    const after = apply(doc, [{ op: "imageDelete", id: "p1" }]);
    expect(after.images).toBeUndefined();
    expect(apply(after, invertChange(doc, after)).images).toEqual({ p1: picture });
    expect(isSheetImage({ ...picture, src: "data:image/svg+xml;base64,PHN2Zz4=" })).toBe(false);
    expect(
      parseChange({
        clientId: "c",
        seq: 1,
        ops: [{ op: "imagePut", id: "p2", image: { ...picture, src: "javascript:x" } }],
      }).ok,
    ).toBe(false);
  });

  it("moves a picture by its place alone, and back the same way", () => {
    const doc = apply(emptyDoc(), [{ op: "imagePut", id: "p1", image: picture }]);
    const place = { at: { r: "s1.r5", c: "s1.c1" }, size: { width: 50, height: 40 } };
    const op = { op: "imagePlace", id: "p1", place } as const;
    expect(parseChange({ clientId: "c", seq: 1, ops: [op] }).ok).toBe(true);
    // A place cannot smuggle in other fields, the picture's bytes among them.
    expect(
      parseChange({
        clientId: "c",
        seq: 1,
        ops: [{ ...op, place: { ...place, src: picture.src } }],
      }).ok,
    ).toBe(false);
    const moved = apply(doc, [op]);
    expect(moved.images!.p1).toEqual({ ...picture, ...place });
    const undo = invertChange(doc, moved);
    expect(undo).toEqual([
      { op: "imagePlace", id: "p1", place: { at: picture.at, size: picture.size } },
    ]);
    expect(apply(moved, undo).images).toEqual(doc.images);
  });
});
