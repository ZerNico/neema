import { describe, expect, it } from "vitest";
import { DE_DE, EN_US } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { renderFormula } from "@chat/sheet/model/formula";
import { emptyDoc, positions, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import {
  clearSelection,
  copySelection,
  formatSelection,
  deleteAtSelection,
  dragOverwrites,
  dragSelection,
  enterCell,
  enterSelection,
  fillFromHandle,
  fillSelection,
  hideAtSelection,
  insertAtSelection,
  parseTabular,
  pasteAtSelection,
  eachRange,
  sheetCsv,
  sortSelection,
  chartFromSelection,
  type GridContext,
} from "./commands.ts";
import { selectionStats } from "./format-commands.ts";
import { cellSource } from "./display.ts";

let minted = 0;
let revision = 0;
const apply = (doc: SheetDoc, ops: readonly SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
/** A cell by A1-style row and column numbers, as IDs at current positions. */
const at = (doc: SheetDoc, row: number, col: number) => ({
  r: positions(doc.sheet.s1!.rows).ids[row - 1]!,
  c: positions(doc.sheet.s1!.cols).ids[col - 1]!,
});
const context = (
  doc: SheetDoc,
  from: [number, number],
  to: [number, number] = from,
  locale = EN_US,
): GridContext => ({
  doc,
  sheet: "s1",
  selection: { anchor: at(doc, ...from), head: at(doc, ...to) },
  values: calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 }),
  locale,
  mint: () => `n${++minted}`,
});
const type = (doc: SheetDoc, row: number, col: number, raw: string, locale = EN_US) =>
  apply(doc, enterCell(context(doc, [row, col], [row, col], locale), at(doc, row, col), raw));
const shown = (doc: SheetDoc, row: number, col: number) => {
  const { r, c } = at(doc, row, col);
  return calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 }).value("s1", r, c);
};
const formulaAt = (doc: SheetDoc, row: number, col: number) => {
  const { r, c } = at(doc, row, col);
  const f = doc.sheet.s1!.cells[r]?.[c]?.f;
  return f ? renderFormula(f, { doc, sheet: "s1" }) : undefined;
};

describe("typing into a cell", () => {
  it("reads numbers in the sheet's locale, keeping the format they were typed in", () => {
    let doc = type(emptyDoc(), 1, 1, "12,5 %", DE_DE);
    const { r, c } = at(doc, 1, 1);
    expect(doc.sheet.s1!.cells[r]![c]).toMatchObject({ v: 0.125, s: '{"numberFormat":"0.00%"}' });
    doc = type(doc, 2, 1, "'=not a formula");
    expect(shown(doc, 2, 1)).toBe("=not a formula");
  });

  it("reads a formula in the locale's separators, keeps it in English and shows it back", () => {
    let doc = type(emptyDoc(), 1, 1, "5");
    doc = type(doc, 1, 2, "=ROUND(A1/3;2)*1,5", DE_DE);
    expect(formulaAt(doc, 1, 2)).toBe("ROUND(A1/3,2)*1.5");
    expect(shown(doc, 1, 2)).toBe(2.505);
    const { r, c } = at(doc, 1, 2);
    expect(cellSource(doc, "s1", r, c, DE_DE)).toBe("=ROUND(A1/3;2)*1,5");
    expect(cellSource(doc, "s1", r, c, EN_US)).toBe("=ROUND(A1/3,2)*1.5");
  });

  it("makes a formula, growing the grid for a reference past it", () => {
    let doc = type(emptyDoc(), 1, 1, "5");
    doc = type(doc, 1, 2, "=A1*2+A1200");
    expect(positions(doc.sheet.s1!.rows).ids).toHaveLength(1200);
    expect(shown(doc, 1, 2)).toBe(10);
  });
});

describe("editing the selection", () => {
  it("inserts as many rows as are selected, and deletes them again", () => {
    let doc = type(emptyDoc(), 2, 1, "keep");
    doc = apply(doc, insertAtSelection(context(doc, [2, 1], [3, 1]), "rows", "before"));
    expect(shown(doc, 4, 1)).toBe("keep");
    doc = apply(doc, deleteAtSelection(context(doc, [2, 1], [3, 1]), "rows"));
    expect(shown(doc, 2, 1)).toBe("keep");
  });

  it("clears contents and sorts by the active column, blanks last", () => {
    let doc = emptyDoc();
    for (const [row, name, score] of [
      [1, "b", "2"],
      [2, "a", "=1+2"],
      [3, "c", ""],
      [4, "d", "1"],
    ] as const) {
      doc = type(doc, row, 1, name);
      if (score) doc = type(doc, row, 2, score);
    }
    doc = apply(doc, sortSelection(context(doc, [1, 1], [4, 2]), true));
    expect([1, 2, 3, 4].map((row) => shown(doc, row, 1))).toEqual(["a", "b", "d", "c"]);
    doc = apply(doc, clearSelection(context(doc, [1, 1], [1, 2])));
    expect([shown(doc, 1, 1), shown(doc, 1, 2)]).toEqual([null, null]);
  });

  it("keeps a sort needing growth as an operation whose refusal the caller can report", () => {
    let doc = type(emptyDoc(), 1, 1, "30");
    doc = type(doc, 2, 1, "10");
    doc = type(doc, 1, 2, "=A1000+A1");
    const idsBefore = minted;
    const ops = sortSelection(context(doc, [2, 2], [1, 1]), false);
    expect(ops).toHaveLength(1);
    expect(minted).toBe(idsBefore);
    const result = applyChange(doc, { clientId: "t", seq: 1, ops }, 1);
    expect(result.dropped).toEqual(["a sort whose shifted formulas need more rows or columns"]);
    expect(result.doc).toBe(doc);
    expect(formulaAt(result.doc, 1, 2)).toBe("A1000+A1");
  });

  it("fills a formula down, each copy reading its own row", () => {
    let doc = type(emptyDoc(), 1, 1, "1");
    doc = type(doc, 2, 1, "2");
    doc = type(doc, 1, 2, "=A1*10");
    doc = apply(doc, fillSelection(context(doc, [1, 2], [2, 2]), "down"));
    expect(formulaAt(doc, 2, 2)).toBe("A2*10");
    expect(shown(doc, 2, 2)).toBe(20);
  });
});

describe("the clipboard", () => {
  it("pastes its own copy with formulas shifted, and a cut as a move", () => {
    let doc = type(emptyDoc(), 1, 1, "3");
    doc = type(doc, 1, 2, "=A1+1");
    const copied = copySelection(context(doc, [1, 1], [1, 2]));
    expect(copied.text).toBe("3\t4");
    doc = apply(doc, pasteAtSelection(context(doc, [3, 1]), copied.text, copied));
    expect(formulaAt(doc, 3, 2)).toBe("A3+1");
    const cut = copySelection(context(doc, [1, 1]), true);
    doc = apply(doc, pasteAtSelection(context(doc, [5, 3]), cut.text, cut));
    expect([shown(doc, 1, 1), shown(doc, 5, 3)]).toEqual([null, 3]);
    // A formula reading the cut cell follows it.
    expect(formulaAt(doc, 1, 2)).toBe("C5+1");
  });

  it("pastes formats with its own copy, and pastes values, formulas, formats or transposed", () => {
    let doc = type(emptyDoc(), 1, 1, "3");
    doc = type(doc, 1, 2, "=A1+1");
    doc = apply(doc, formatSelection(context(doc, [1, 1]), { bold: true }));
    doc = apply(doc, formatSelection(context(doc, [4, 1]), { italic: true }));
    const style = (row: number, col: number) => {
      const { r, c } = at(doc, row, col);
      return doc.sheet.s1!.cells[r]?.[c]?.s;
    };
    const copied = copySelection(context(doc, [1, 1], [1, 2]));
    doc = apply(doc, pasteAtSelection(context(doc, [4, 1]), copied.text, copied));
    // The target takes the source's style exactly: bold in, its own italic out.
    expect([style(4, 1), style(4, 2)]).toEqual(['{"bold":true}', undefined]);
    doc = apply(
      doc,
      pasteAtSelection(context(doc, [5, 1]), copied.text, copied, { part: "values" }),
    );
    expect([shown(doc, 5, 2), formulaAt(doc, 5, 2), style(5, 1)]).toEqual([
      4,
      undefined,
      undefined,
    ]);
    doc = apply(
      doc,
      pasteAtSelection(context(doc, [6, 1]), copied.text, copied, { part: "formulas" }),
    );
    expect([formulaAt(doc, 6, 2), style(6, 1)]).toEqual(["A6+1", undefined]);
    doc = apply(
      doc,
      pasteAtSelection(context(doc, [7, 3]), copied.text, copied, { part: "formats" }),
    );
    expect([shown(doc, 7, 3), style(7, 3)]).toEqual([null, '{"bold":true}']);
    doc = apply(
      doc,
      pasteAtSelection(context(doc, [9, 1]), copied.text, copied, { transpose: true }),
    );
    expect([shown(doc, 9, 1), formulaAt(doc, 10, 1)]).toEqual([3, "A9+1"]);
    // A cut pasted as values copies instead of moving.
    const cut = copySelection(context(doc, [1, 1]), true);
    doc = apply(doc, pasteAtSelection(context(doc, [12, 1]), cut.text, cut, { part: "values" }));
    expect([shown(doc, 1, 1), shown(doc, 12, 1)]).toEqual([3, 3]);
  });

  it("wraps a value typed with a line break, so the break shows", () => {
    const doc = type(emptyDoc(), 1, 1, "Line one\nline two");
    const { r, c } = at(doc, 1, 1);
    expect(doc.sheet.s1!.cells[r]![c]).toMatchObject({
      v: "Line one\nline two",
      s: '{"wrap":true}',
    });
  });

  it("makes typed web and mail addresses links, and leaves other text alone", () => {
    let doc = type(emptyDoc(), 1, 1, "www.example.com");
    doc = type(doc, 2, 1, "ana@example.com");
    doc = type(doc, 3, 1, "not a link.com");
    doc = type(doc, 4, 1, "javascript:alert(1)");
    const link = (row: number) => {
      const { r, c } = at(doc, row, 1);
      const s = doc.sheet.s1!.cells[r]?.[c]?.s;
      return s ? (JSON.parse(s) as { link?: string }).link : undefined;
    };
    expect([link(1), link(2), link(3), link(4)]).toEqual([
      "https://www.example.com/",
      "mailto:ana@example.com",
      undefined,
      undefined,
    ]);
  });

  it("types in text from elsewhere, quoted fields included", () => {
    expect(parseTabular('a\t"b\tc"\n"say ""hi"""\t2\n')).toEqual([
      ["a", "b\tc"],
      ['say "hi"', "2"],
    ]);
    const doc = apply(
      emptyDoc(),
      pasteAtSelection(context(emptyDoc(), [1, 1]), "x\t=1+1\n7%", null),
    );
    expect([shown(doc, 1, 1), shown(doc, 1, 2), shown(doc, 2, 1)]).toEqual(["x", 2, 0.07]);
  });
});

describe("several ranges", () => {
  it("formats each selected range, and leaves the cells between alone", () => {
    const doc = emptyDoc();
    const several = {
      ...context(doc, [3, 3]),
      selection: {
        anchor: at(doc, 3, 3),
        head: at(doc, 3, 3),
        more: [{ anchor: at(doc, 1, 1), head: at(doc, 1, 2) }],
      },
    };
    const next = apply(
      doc,
      eachRange(several, (each) => formatSelection(each, { bold: true })),
    );
    const bold = (row: number, col: number) => {
      const { r, c } = at(next, row, col);
      return next.sheet.s1!.cells[r]?.[c]?.s;
    };
    expect([bold(1, 1), bold(1, 2), bold(3, 3), bold(2, 2)]).toEqual([
      '{"bold":true}',
      '{"bold":true}',
      '{"bold":true}',
      undefined,
    ]);
  });

  it("sums every selected range for the status bar, counting a shared cell once", () => {
    let doc = type(emptyDoc(), 1, 1, "2");
    doc = type(doc, 2, 1, "3");
    doc = type(doc, 5, 5, "10");
    const stats = selectionStats({
      ...context(doc, [5, 5]),
      selection: {
        anchor: at(doc, 5, 5),
        head: at(doc, 5, 5),
        more: [
          { anchor: at(doc, 1, 1), head: at(doc, 2, 1) },
          { anchor: at(doc, 2, 1), head: at(doc, 2, 1) },
        ],
      },
    });
    expect(stats).toMatchObject({ count: 3, sum: 15 });
  });
});

describe("CSV", () => {
  it("writes each cell's shown text over the used range, quoting what needs it", () => {
    let doc = type(emptyDoc(), 1, 1, "Name, first");
    doc = type(doc, 1, 3, "0.5");
    doc = type(doc, 2, 2, 'Say "hi"');
    doc = apply(doc, formatSelection(context(doc, [1, 3]), { numberFormat: "0%" }));
    expect(sheetCsv(context(doc, [1, 1]), "s1")).toBe('"Name, first",,50%\r\n,"Say ""hi""",\r\n');
  });

  it("includes what a formula spills, past the cells holding anything", () => {
    const doc = type(emptyDoc(), 1, 1, "=SEQUENCE(3,2)");
    expect(sheetCsv(context(doc, [1, 1]), "s1")).toBe("1,2\r\n3,4\r\n5,6\r\n");
  });
});

describe("charting the selection", () => {
  it("names series from the header row, labels points from the first column, and sits beside", () => {
    let doc = emptyDoc();
    for (const [row, cells] of [
      [1, ["Month", "Sales", "Costs"]],
      [2, ["Jan", "10", "4"]],
      [3, ["Feb", "20", "6"]],
    ] as const)
      cells.forEach((raw, index) => {
        doc = type(doc, row, index + 1, raw);
      });
    const [op] = chartFromSelection(context(doc, [1, 1], [3, 3]), "column");
    expect(op).toMatchObject({
      op: "chartPut",
      chart: {
        kind: "column",
        at: at(doc, 1, 5),
        // Names read from their header cells, so they follow edits there.
        series: [
          {
            name: { cell: { sh: "s1", r: at(doc, 1, 2).r, c: at(doc, 1, 2).c } },
            values: { r1: at(doc, 2, 1).r, r2: at(doc, 3, 1).r, c1: at(doc, 1, 2).c },
          },
          {
            name: { cell: { sh: "s1", r: at(doc, 1, 3).r, c: at(doc, 1, 3).c } },
            categories: { c1: at(doc, 1, 1).c },
          },
        ],
      },
    });
    expect(chartFromSelection(context(doc, [1, 1], [3, 3]), "pie")[0]).toMatchObject({
      chart: { series: [{ values: { c1: at(doc, 1, 2).c } }] },
    });
    expect(chartFromSelection(context(doc, [1, 1]), "line")).toEqual([]);
  });
});

describe("the fill handle", () => {
  it("fills down beside the data on a double-click, past the grid if it must, and selects it all", () => {
    let doc = emptyDoc();
    for (let row = 1; row <= 40; row++) doc = type(doc, row, 1, String(row));
    doc = type(doc, 1, 2, "=A1*2");
    const result = fillFromHandle(context(doc, [1, 2]), {
      direction: "down",
      count: "auto",
      mode: "auto",
    })!;
    doc = apply(doc, result.ops);
    expect(formulaAt(doc, 40, 2)).toBe("A40*2");
    expect(shown(doc, 41, 2)).toBeNull();
    expect(result.selection).toEqual({ anchor: at(doc, 1, 2), head: at(doc, 40, 2) });
  });

  it("grows the grid for a filled formula that reaches past it", () => {
    let doc = type(emptyDoc(), 1, 1, "=B1");
    const result = fillFromHandle(context(doc, [1, 1]), {
      direction: "right",
      count: 25,
      mode: "auto",
    })!;
    doc = apply(doc, result.ops);
    expect(formulaAt(doc, 1, 26)).toBe("AA1");
  });

  it("clears the rows the handle is dragged back over, as Excel does", () => {
    let doc = emptyDoc();
    for (let row = 1; row <= 4; row++) doc = type(doc, row, 1, String(row));
    const result = fillFromHandle(context(doc, [1, 1], [4, 1]), {
      direction: "down",
      count: -2,
      mode: "auto",
    })!;
    doc = apply(doc, result.ops);
    expect([1, 2, 3, 4].map((row) => shown(doc, row, 1))).toEqual([1, 2, null, null]);
    expect(result.selection).toEqual({ anchor: at(doc, 1, 1), head: at(doc, 2, 1) });
  });

  it("counts on a dragged series and grows the grid for it", () => {
    let doc = type(emptyDoc(), 1, 1, "Mon");
    const result = fillFromHandle(context(doc, [1, 1]), {
      direction: "right",
      count: 30,
      mode: "auto",
    })!;
    doc = apply(doc, result.ops);
    expect([shown(doc, 1, 2), shown(doc, 1, 8), shown(doc, 1, 31)]).toEqual(["Tue", "Mon", "Wed"]);
  });
});

describe("dragging the selection by its border", () => {
  it("moves cells so formulas that read them follow, or copies them with their formats", () => {
    let doc = type(emptyDoc(), 1, 1, "5");
    doc = type(doc, 1, 2, "=A1*2");
    doc = type(doc, 2, 1, "12,5%");
    expect(dragOverwrites(context(doc, [1, 1], [2, 1]), { rows: 0, cols: 1 })).toBe(true);
    expect(dragOverwrites(context(doc, [1, 1], [2, 1]), { rows: 1, cols: 0 })).toBe(false);
    const moved = dragSelection(context(doc, [1, 1], [2, 1]), { rows: 2, cols: 2 }, false)!;
    const after = apply(doc, moved.ops);
    expect(formulaAt(after, 1, 2)).toBe("C3*2");
    expect(shown(after, 1, 2)).toBe(10);
    expect(moved.selection).toEqual({ anchor: at(after, 3, 3), head: at(after, 4, 3) });
    const copied = apply(
      doc,
      dragSelection(context(doc, [1, 1], [2, 2]), { rows: 0, cols: 3 }, true)!.ops,
    );
    expect(formulaAt(copied, 1, 5)).toBe("D1*2");
    expect(shown(copied, 1, 1)).toBe(5);
    const { r, c } = at(copied, 2, 4);
    expect(copied.sheet.s1!.cells[r]![c]!.s).toBe(
      doc.sheet.s1!.cells[at(doc, 2, 1).r]![at(doc, 2, 1).c]!.s,
    );
  });
});

describe("Ctrl+Enter", () => {
  it("writes what was typed into every selected cell, a formula shifted to each", () => {
    let doc = emptyDoc();
    for (let row = 1; row <= 3; row++) doc = type(doc, row, 1, String(row * 10));
    // The active cell is the selection's head, where the edit was typed.
    doc = apply(doc, enterSelection(context(doc, [3, 2], [1, 2]), "=A1*2"));
    expect([formulaAt(doc, 1, 2), formulaAt(doc, 3, 2), shown(doc, 3, 2)]).toEqual([
      "A1*2",
      "A3*2",
      60,
    ]);
    doc = apply(doc, enterSelection(context(doc, [1, 3], [2, 4]), "5 %"));
    expect([shown(doc, 2, 4), doc.sheet.s1!.cells[at(doc, 2, 4).r]![at(doc, 2, 4).c]!.s]).toEqual([
      0.05,
      '{"numberFormat":"0%"}',
    ]);
  });
});

describe("copies that reach past the grid", () => {
  const colCount = (doc: SheetDoc) => positions(doc.sheet.s1!.cols).ids.length;

  it("grows the grid for Ctrl+Enter and Fill Right rather than writing #REF!", () => {
    const doc = emptyDoc();
    const entered = apply(doc, enterSelection(context(doc, [1, 26], [1, 1]), "=B1"));
    expect(formulaAt(entered, 1, 26)).toBe("AA1");
    const typed = type(emptyDoc(), 1, 1, "=B1");
    const filled = apply(typed, fillSelection(context(typed, [1, 1], [1, 26]), "right"));
    expect(formulaAt(filled, 1, 26)).toBe("AA1");
    expect(colCount(filled)).toBe(27);
  });

  it("grows once for formulas pasted from another program, each against the last", () => {
    const doc = emptyDoc();
    const pasted = apply(doc, pasteAtSelection(context(doc, [1, 1]), "=AB1\t=AC1", null));
    expect([formulaAt(pasted, 1, 1), formulaAt(pasted, 1, 2)]).toEqual(["AB1", "AC1"]);
    expect(colCount(pasted)).toBe(29);
  });

  it("fills down a cell's format and link along with its value", () => {
    let doc = type(emptyDoc(), 1, 1, "Docs");
    doc = apply(
      doc,
      formatSelection(context(doc, [1, 1]), { bold: true, link: "https://example.com" }),
    );
    doc = apply(doc, fillSelection(context(doc, [1, 1], [3, 1]), "down"));
    const { r, c } = at(doc, 3, 1);
    expect(doc.sheet.s1!.cells[r]![c]).toMatchObject({
      v: "Docs",
      s: '{"bold":true,"link":"https://example.com"}',
    });
  });
});

describe("hiding rows and columns", () => {
  it("hides what is selected, and shows again only the hidden ones a selection spans", () => {
    let doc = apply(emptyDoc(), hideAtSelection(context(emptyDoc(), [2, 2], [3, 2]), "rows", true));
    expect(doc.sheet.s1!.rowProps["s1.r2"]?.hidden).toBe(true);
    const unhide = hideAtSelection(context(doc, [1, 1], [4, 1]), "rows", false);
    expect(unhide).toEqual([
      { op: "hide", sh: "s1", axis: "rows", ids: ["s1.r2", "s1.r3"], hidden: false },
    ]);
    doc = apply(doc, unhide);
    expect(doc.sheet.s1!.rowProps["s1.r2"]?.hidden).toBeUndefined();
  });
});
