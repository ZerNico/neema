import { describe, expect, it } from "vitest";
import { parseCell } from "@chat/sheet/a1";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet, type CalcContext } from "@chat/sheet/model/calc";
import { renderFormula } from "@chat/sheet/model/formula";
import { emptyDoc, positions, sheetNamed, type SheetDoc } from "@chat/sheet/model";
import { parseLiveSheetOperations } from "../live-operations.ts";
import { convertOperations } from "./convert.ts";

const context: CalcContext = { revision: 1, epoch: 0, now: 45_000, seed: 1 };
let minted = 0;
let revision = 0;
/** Converts as the model's call would, at `seen`, and commits it as one revision. */
const edit = (doc: SheetDoc, operations: unknown[], seen = revision, own = new Set<number>()) => {
  const converted = convertOperations(
    { doc, seen, own, mint: () => `m.${++minted}`, context },
    parseLiveSheetOperations(operations),
  );
  if (!converted.ok) return converted;
  revision += 1;
  return {
    ok: true as const,
    doc: applyChange(doc, { clientId: "m", seq: revision, ops: converted.ops }, revision).doc,
  };
};
const done = (result: ReturnType<typeof edit>) => {
  if (!result.ok) throw new Error(result.message);
  return result.doc;
};
const at = (doc: SheetDoc, address: string, name = "Sheet1") => {
  const sheet = sheetNamed(doc, name)!;
  const { row, column } = parseCell(address)!;
  return {
    sheet,
    r: positions(doc.sheet[sheet]!.rows).ids[row - 1]!,
    c: positions(doc.sheet[sheet]!.cols).ids[column - 1]!,
  };
};
const value = (doc: SheetDoc, address: string, name = "Sheet1") => {
  const { sheet, r, c } = at(doc, address, name);
  return calculateSheet(doc, context).value(sheet, r, c);
};
const formulaAt = (doc: SheetDoc, address: string, name = "Sheet1") => {
  const { sheet, r, c } = at(doc, address, name);
  const f = doc.sheet[sheet]!.cells[r]?.[c]?.f;
  return f ? renderFormula(f, { doc, sheet }) : undefined;
};

describe("converting the model's sheet edits", () => {
  it("applies each operation to what the ones before it made", () => {
    const doc = done(
      edit(emptyDoc(), [
        { kind: "addSheet", name: "Data" },
        { kind: "setCells", sheet: "Data", start: "A1", rows: [[2], [3]] },
        { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["=SUM(Data!A1:A2)*2"]] },
      ]),
    );
    expect(value(doc, "A1")).toBe(10);
  });

  it("inserts rows and fills a formula down them, each copy reading its own row", () => {
    let doc = done(
      edit(emptyDoc(), [
        { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[1], [2], [3]] },
        { kind: "setCells", sheet: "Sheet1", start: "B1", rows: [["=A1*10"]] },
      ]),
    );
    doc = done(
      edit(doc, [
        { kind: "insertRows", sheet: "Sheet1", rows: "2" },
        { kind: "setCells", sheet: "Sheet1", start: "A2", rows: [[5]] },
        { kind: "fill", sheet: "Sheet1", source: "B1", range: "B2:B4" },
      ]),
    );
    expect(formulaAt(doc, "B4")).toBe("A4*10");
    expect([1, 2, 3, 4].map((row) => value(doc, `B${row}`))).toEqual([10, 50, 20, 30]);
  });

  it("grows the grid to hold what is written past it", () => {
    const doc = done(
      edit(emptyDoc(), [
        { kind: "setCells", sheet: "Sheet1", start: "AB1005", rows: [[1]] },
        { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["=AB1005+A2000"]] },
      ]),
    );
    expect(positions(doc.sheet.s1!.rows).ids).toHaveLength(2000);
    expect(value(doc, "A1")).toBe(1);
  });

  it("refuses to write over what someone changed since the model's view, unless it wrote it", () => {
    const seen = revision;
    // A person writes A1 after the model's view.
    revision += 1;
    const theirs = revision;
    const doc = applyChange(
      emptyDoc(),
      {
        clientId: "person",
        seq: 1,
        ops: [{ op: "set", sh: "s1", cells: [{ r: "s1.r1", c: "s1.c1", v: "theirs" }] }],
      },
      revision,
    ).doc;
    const write = [{ kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["mine"]] }];
    expect(edit(doc, write, seen)).toMatchObject({ ok: false, outcome: "conflict" });
    expect(edit(doc, [{ kind: "deleteRows", sheet: "Sheet1", rows: "1" }], seen)).toMatchObject({
      ok: false,
      outcome: "conflict",
    });
    expect(edit(doc, write, seen, new Set([theirs]))).toMatchObject({ ok: true });
    // Writing beside it is fine.
    expect(
      edit(doc, [{ kind: "setCells", sheet: "Sheet1", start: "B1", rows: [["mine"]] }], seen),
    ).toMatchObject({ ok: true });
  });

  it("sorts by calculated values, blanks last, keeping the header", () => {
    let doc = done(
      edit(emptyDoc(), [
        {
          kind: "setCells",
          sheet: "Sheet1",
          start: "A1",
          rows: [
            ["Name", "Score"],
            ["b", 2],
            ["blank", null],
            ["a", "=1+2"],
            ["c", 1],
          ],
        },
      ]),
    );
    doc = done(
      edit(doc, [
        { kind: "sort", sheet: "Sheet1", range: "A1:B5", by: "B", descending: true, header: true },
      ]),
    );
    expect(["A1", "A2", "A3", "A4", "A5"].map((address) => value(doc, address))).toEqual([
      "Name",
      "a",
      "b",
      "c",
      "blank",
    ]);
  });

  it("copies formulas to another sheet, read there as written", () => {
    let doc = done(
      edit(emptyDoc(), [
        { kind: "addSheet", name: "Copy" },
        { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[4, "=A1*2"]] },
        { kind: "setCells", sheet: "Copy", start: "A2", rows: [[7]] },
      ]),
    );
    doc = done(
      edit(doc, [{ kind: "copy", sheet: "Sheet1", range: "B1", to: "B2", toSheet: "Copy" }]),
    );
    expect(formulaAt(doc, "B2", "Copy")).toBe("A2*2");
    expect(value(doc, "B2", "Copy")).toBe(14);
  });

  it("names what it cannot find", () => {
    expect(edit(emptyDoc(), [{ kind: "clearRange", sheet: "Nope", range: "A1" }])).toMatchObject({
      ok: false,
      outcome: "not_found",
      message: "No sheet named Nope. Sheets: Sheet1.",
    });
  });
});
