import { describe, expect, it } from "vitest";
import { parseCell } from "@chat/sheet/a1";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet, type CalcContext } from "@chat/sheet/model/calc";
import { renderFormula } from "@chat/sheet/model/formula";
import { emptyDoc, positions, sheetNamed, type SheetDoc } from "@chat/sheet/model";
import { parseLiveSheetOperations } from "../live-operations.ts";
import { convertOperations } from "./convert.ts";
import { sheetView } from "./sheet-view.ts";

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
    // Rows of different lengths write only their own cells: B2 is in their box, not written.
    const below = applyChange(
      doc,
      {
        clientId: "person",
        seq: 2,
        ops: [{ op: "set", sh: "s1", cells: [{ r: "s1.r2", c: "s1.c2", v: "theirs" }] }],
      },
      theirs,
    ).doc;
    const ragged = [{ kind: "setCells", sheet: "Sheet1", start: "A2", rows: [["x"], ["y", "z"]] }];
    expect(edit(below, ragged, seen)).toMatchObject({ ok: true });
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

describe("the model's filters", () => {
  it("filters a column by a condition, shows what it hides, and removes it", () => {
    let doc = done(
      edit(emptyDoc(), [
        {
          kind: "setCells",
          sheet: "Sheet1",
          start: "A1",
          rows: [
            ["Region", "Total"],
            ["North", 120],
            ["South", 80],
            ["East", 40],
          ],
        },
        {
          kind: "setFilter",
          sheet: "Sheet1",
          range: "A1:B4",
          column: "B",
          condition: "greater",
          value: "50",
        },
      ]),
    );
    expect(doc.sheet.s1!.filter?.rules).toEqual({
      [at(doc, "B1").c]: { condition: { op: "greater", value: 50 } },
    });
    const shown = sheetView(doc, calculateSheet(doc, context)).xml;
    expect(shown).toContain('<filter range="A1:B4" hides="1 rows">');
    expect(shown).toContain('<rule column="B" condition="greater" value="50"/>');
    doc = done(edit(doc, [{ kind: "setFilter", sheet: "Sheet1", column: "A", keep: ["North"] }]));
    expect(Object.keys(doc.sheet.s1!.filter!.rules)).toHaveLength(2);
    expect(
      edit(doc, [{ kind: "setFilter", sheet: "Sheet1", column: "D", keep: ["x"] }]),
    ).toMatchObject({
      ok: false,
    });
    doc = done(edit(doc, [{ kind: "removeFilter", sheet: "Sheet1" }]));
    expect(doc.sheet.s1!.filter).toBeUndefined();
  });
});

describe("the model's conditional formats", () => {
  it("adds highlight rules, scales and bars, shows them in the view, and clears them", () => {
    let doc = done(
      edit(emptyDoc(), [
        { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[10], [40], [25]] },
        {
          kind: "addConditionalFormat",
          sheet: "Sheet1",
          range: "A1:A3",
          type: "greater",
          value: "20",
        },
        { kind: "addConditionalFormat", sheet: "Sheet1", range: "A1:A3", type: "dataBar" },
      ]),
    );
    expect(doc.sheet.s1!.conditional!.map((each) => each.rule.kind)).toEqual(["compare", "bar"]);
    const shown = sheetView(doc, calculateSheet(doc, context)).xml;
    expect(shown).toContain(
      '<rule range="A1:A3" is="greater 20" fill="#FFC7CE" fontColor="#9C0006"/>',
    );
    expect(shown).toContain('<rule range="A1:A3" is="dataBar #638EC6"/>');
    expect(
      edit(doc, [
        { kind: "addConditionalFormat", sheet: "Sheet1", range: "A1", type: "between", value: "1" },
      ]),
    ).toMatchObject({ ok: false });
    doc = done(edit(doc, [{ kind: "clearConditionalFormats", sheet: "Sheet1", range: "B1" }]));
    expect(doc.sheet.s1!.conditional).toHaveLength(2);
    // From A3 alone, each rule keeps A1:A2.
    doc = done(edit(doc, [{ kind: "clearConditionalFormats", sheet: "Sheet1", range: "A3" }]));
    expect(sheetView(doc, calculateSheet(doc, context)).xml).toContain(
      '<rule range="A1:A2" is="dataBar #638EC6"/>',
    );
    doc = done(edit(doc, [{ kind: "clearConditionalFormats", sheet: "Sheet1" }]));
    expect(doc.sheet.s1!.conditional).toBeUndefined();
  });

  it("sets data validation over other rules' cells, clears it from exactly a range", () => {
    let doc = done(
      edit(emptyDoc(), [
        { kind: "addSheet", name: "Lists" },
        { kind: "setCells", sheet: "Lists", start: "A1", rows: [["Open"], ["Done"]] },
        {
          kind: "setValidation",
          sheet: "Sheet1",
          range: "B2:B9",
          type: "list",
          choices: ["Yes", "No"],
        },
        {
          kind: "setValidation",
          sheet: "Sheet1",
          range: "B2:B20",
          type: "list",
          source: "Lists!A1:A2",
          onError: "warning",
        },
        {
          kind: "setValidation",
          sheet: "Sheet1",
          range: "C2:C9",
          type: "date",
          test: "greaterOrEqual",
          value: "2026-01-31",
          allowBlank: false,
          message: "From February on",
        },
      ]),
    );
    const list = doc.sheet.s1!.validations!;
    expect(list.map((each) => each.rule.kind)).toEqual(["list", "date"]);
    expect(list[0]).toMatchObject({ onError: "warning", allowBlank: true });
    const shown = sheetView(doc, calculateSheet(doc, context)).xml;
    expect(shown).toContain(
      '<validation range="B2:B20" type="list" source="Lists!A1:A2" onError="warning"/>',
    );
    expect(shown).toContain(
      '<validation range="C2:C9" type="date" test="greaterOrEqual" value="2026-01-31" onError="stop" allowBlank="false" message="From February on"/>',
    );
    expect(
      edit(doc, [{ kind: "setValidation", sheet: "Sheet1", range: "A1", type: "whole" }]),
    ).toMatchObject({ ok: false });
    expect(
      edit(doc, [{ kind: "setValidation", sheet: "Sheet1", range: "A1", type: "list" }]),
    ).toMatchObject({ ok: false });
    // A setValidation that would split rules past the sheet's limit refuses the call whole.
    // With the two rules there, 198 more fill the sheet's 200.
    const many = Array.from({ length: 198 }, (_, n) => ({
      kind: "setValidation",
      sheet: "Sheet1",
      range: `F${n + 1}`,
      type: "list",
      choices: ["a"],
    }));
    const full = done(edit(done(edit(doc, many.slice(0, 99))), many.slice(99)));
    expect(
      edit(full, [
        { kind: "setValidation", sheet: "Sheet1", range: "B5", type: "list", choices: ["b"] },
      ]),
    ).toMatchObject({ ok: false, outcome: "invalid" });
    // Cleared from C5 alone: the date rule keeps the cells above and below it.
    doc = done(edit(doc, [{ kind: "clearValidation", sheet: "Sheet1", range: "C5" }]));
    expect(sheetView(doc, calculateSheet(doc, context)).xml).toMatch(
      /range="C2:C4" type="date"[^]*range="C6:C9" type="date"/,
    );
    doc = done(edit(doc, [{ kind: "clearValidation", sheet: "Sheet1" }]));
    expect(doc.sheet.s1!.validations ?? []).toEqual([]);
  });
});
