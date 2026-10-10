import { MAX_COLUMN, MAX_ROW, parseCell, parseRange } from "@chat/sheet/a1";
import { SpreadsheetError } from "~/modules/spreadsheets/errors.ts";
import {
  SPREADSHEET_OPERATIONS,
  spreadsheetEngine,
  type CellInput,
  type Definition,
  type OperationOf,
} from "~/modules/spreadsheets/operations.ts";

/** At most this many operations and written cells in one edit_sheet call. */
export const LIVE_SHEET_CALL = { operations: 100, cells: 20_000 } as const;

const sheet = { type: "sheet", about: "Sheet name, as the view's <tab> lists it." } as const;
const range = {
  type: "range",
  about: 'A cell or rectangle on the sheet, e.g. "B2" or "A1:D20".',
} as const;
const rows = {
  type: "rowSpan",
  about: 'A row or span, e.g. "5" or "5:7".',
} as const;
const columns = { type: "columns", about: 'A column or span, e.g. "B" or "B:D".' } as const;
const { setCells, setFormat } = SPREADSHEET_OPERATIONS;

/**
 * What the model may do to a live sheet: the Excel tools' edits that a live
 * sheet keeps, with the sheet named as the view names it, and the edits only
 * a live sheet has. Each applies to what the ones before it made.
 */
export const LIVE_SHEET_OPERATIONS = {
  setCells: {
    ...setCells,
    about: `${setCells.about} Numbers go as JSON numbers; a date as =DATE(y,m,d) or a serial with a date numberFormat. The grid grows to fit.`,
    fields: { ...setCells.fields, sheet },
  },
  clearRange: { ...SPREADSHEET_OPERATIONS.clearRange, fields: { sheet, range } },
  setFormat: { ...setFormat, fields: { ...setFormat.fields, sheet, range } },
  setColumnWidth: {
    ...SPREADSHEET_OPERATIONS.setColumnWidth,
    fields: { ...SPREADSHEET_OPERATIONS.setColumnWidth.fields, sheet },
  },
  setRowHeight: {
    ...SPREADSHEET_OPERATIONS.setRowHeight,
    fields: { ...SPREADSHEET_OPERATIONS.setRowHeight.fields, sheet },
  },
  mergeCells: { ...SPREADSHEET_OPERATIONS.mergeCells, fields: { sheet, range } },
  unmergeCells: { ...SPREADSHEET_OPERATIONS.unmergeCells, fields: { sheet, range } },
  freezePanes: {
    ...SPREADSHEET_OPERATIONS.freezePanes,
    fields: { ...SPREADSHEET_OPERATIONS.freezePanes.fields, sheet },
  },
  insertRows: {
    about: "Insert empty rows: they take these numbers and push what was there down.",
    fields: { sheet, rows },
    required: ["sheet", "rows"],
    change: ["inserted", "row"],
  },
  deleteRows: {
    about: "Delete rows; what is below moves up. Formulas that used only them show #REF!.",
    fields: { sheet, rows },
    required: ["sheet", "rows"],
    change: ["deleted", "row"],
  },
  insertColumns: {
    about: "Insert empty columns: they take these letters and push what was there right.",
    fields: { sheet, columns },
    required: ["sheet", "columns"],
    change: ["inserted", "column"],
  },
  deleteColumns: {
    about: "Delete columns; what is right of them moves left.",
    fields: { sheet, columns },
    required: ["sheet", "columns"],
    change: ["deleted", "column"],
  },
  fill: {
    about:
      'Repeat source over range, as dragging the fill handle does: a formula shifts its relative references for each cell, a value is copied. e.g. source "D2", range "D3:D50". Values and formulas only, not formats.',
    fields: {
      sheet,
      source: { ...range, about: "The cell or cells to repeat." },
      range: { ...range, about: "Where to repeat them." },
    },
    required: ["sheet", "source", "range"],
    change: ["filled", "range"],
  },
  copy: {
    about:
      "Copy a range's values and formulas to another place, formulas shifting as Excel's copy does. Formats are not copied.",
    fields: {
      sheet,
      range,
      to: { type: "cell", about: "Top-left cell of the copy." },
      toSheet: { ...sheet, about: "Sheet to copy to (default: the same)." },
    },
    required: ["sheet", "range", "to"],
    change: ["copied", "range"],
  },
  sort: {
    about:
      "Sort the rows of a range by one column's values: numbers, then text, then true/false, errors after, blanks last. Formulas move with their rows.",
    fields: {
      sheet,
      range,
      by: { ...columns, about: 'The column to sort by, e.g. "C".' },
      descending: { type: "boolean", about: "Largest first." },
      header: { type: "boolean", about: "The range's first row is a header and stays." },
    },
    required: ["sheet", "range", "by"],
    change: ["sorted", "range"],
  },
  addSheet: {
    ...SPREADSHEET_OPERATIONS.addSheet,
    fields: { name: { ...sheet, about: "New sheet name, at most 31 characters." } },
  },
  renameSheet: {
    ...SPREADSHEET_OPERATIONS.renameSheet,
    fields: { sheet, name: { ...sheet, about: "New name." } },
  },
  moveSheet: {
    about: "Move a sheet's tab to a position, 1 being first.",
    fields: { sheet, position: { type: "integer", min: 1, max: 50, about: "New position." } },
    required: ["sheet", "position"],
    change: ["moved", "sheet"],
  },
  deleteSheet: { ...SPREADSHEET_OPERATIONS.deleteSheet, fields: { sheet } },
  defineName: {
    ...SPREADSHEET_OPERATIONS.defineName,
    fields: { ...SPREADSHEET_OPERATIONS.defineName.fields, sheet, range },
  },
  addChart: {
    ...SPREADSHEET_OPERATIONS.addChart,
    about:
      "Add a chart drawn from cells, which follows them as they change. Categories label the points; each series is one line, bar set or pie. Ranges may name another sheet, e.g. Data!B2:B13.",
    fields: {
      ...SPREADSHEET_OPERATIONS.addChart.fields,
      sheet: { ...sheet, about: "Sheet the chart is placed on." },
    },
  },
  removeChart: {
    about: "Remove a chart, by the id the view gives it in <charts>.",
    fields: { chart: { type: "string", max: 64, about: "The chart's id." } },
    required: ["chart"],
    change: ["removed", "chart"],
  },
} as const satisfies Record<string, Definition>;

export type LiveSheetOperation = OperationOf<typeof LIVE_SHEET_OPERATIONS>;

const engine = spreadsheetEngine(LIVE_SHEET_OPERATIONS, LIVE_SHEET_CALL.operations);
const fail = (path: string, message: string): never => {
  throw new SpreadsheetError("invalid_operation", `${path}: ${message}`);
};

/** Checks an edit_sheet call's operations; throws a `SpreadsheetError` naming the first problem. */
export function parseLiveSheetOperations(input: unknown): LiveSheetOperation[] {
  let cells = 0;
  const operations = engine.parse(input, undefined, (kind, operation, path) => {
    if (kind === "setCells") {
      const start = parseCell(operation.start as string)!;
      const values = operation.rows as CellInput[][];
      const width = Math.max(...values.map((row) => row.length));
      if (start.row + values.length - 1 > MAX_ROW || start.column + width - 1 > MAX_COLUMN)
        fail(path, "the values run past the last row or column of a sheet");
      cells += values.reduce((sum, row) => sum + row.length, 0);
    }
    if (kind === "fill" || kind === "copy") {
      const area = parseRange(operation.range as string)!;
      cells += (area.bottom - area.top + 1) * (area.right - area.left + 1);
    }
    if (
      kind === "setFormat" &&
      Object.keys(operation).every((key) => key === "sheet" || key === "range")
    )
      fail(path, "provide at least one property to change");
    if (
      kind === "addChart" &&
      operation.type === "pie" &&
      (operation.series as unknown[]).length !== 1
    )
      fail(path, "a pie chart takes exactly one series");
    if (kind === "defineName" && !/^[A-Za-z_\\][\w.]{0,99}$/.test(operation.name as string))
      fail(`${path}.name`, "start with a letter; use letters, digits, _ and . only");
  });
  if (cells > LIVE_SHEET_CALL.cells)
    fail(
      "operations",
      `at most ${LIVE_SHEET_CALL.cells} cells per call; received ${cells}. Split into smaller calls; no edits were applied`,
    );
  // Each operation was checked against the table above; the type is the table's.
  return operations as LiveSheetOperation[];
}

export const liveSheetOperationsJsonSchema = engine.jsonSchema;
export const describeLiveSheetChanges: (operations: readonly LiveSheetOperation[]) => string =
  engine.describeChanges;
