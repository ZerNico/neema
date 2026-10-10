import { MAX_COLUMN, MAX_ROW, parseCell, parseRange } from "@chat/sheet/a1";
import { CHART_KINDS } from "@chat/sheet/model/chart";
import { FILTER_CONDITIONS } from "@chat/sheet/model/filter";
import { VALIDATION_TESTS } from "@chat/sheet/model/validation";
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

const chartText = {
  type: "string",
  max: 200,
  about: 'Text, or "=B1" to show that cell and follow it.',
} as const;
const chartRange = {
  type: "string",
  max: 100,
  about: 'A range, e.g. "B2:B13" or "Data!B2:B13".',
} as const;
const axis = (about: string) =>
  ({
    type: "object",
    about,
    fields: {
      title: chartText,
      min: { type: "number", min: -1e15, max: 1e15, about: "Lowest value shown." },
      max: { type: "number", min: -1e15, max: 1e15, about: "Highest value shown." },
      format: {
        type: "string",
        max: 100,
        about: 'Excel number format of its labels, e.g. "$#,##0" or "0%"; default the cells\' own.',
      },
      log: { type: "boolean", about: "Logarithmic scale." },
      gridlines: { type: "boolean", about: "Draw gridlines." },
    },
    required: [],
  }) as const;
/** Chart options editChart can remove. */
export const CLEARABLE = [
  "title",
  "subtitle",
  "stack",
  "legend",
  "xAxis",
  "yAxis",
  "rightAxis",
  "labels",
  "hole",
] as const;
/** Every option a chart has, as addChart and editChart take them. */
const CHART_OPTIONS = {
  type: {
    type: "string",
    max: 10,
    options: CHART_KINDS,
    about:
      "column, bar (horizontal), line, area, pie, doughnut, scatter (x then y), bubble (x, y, size), waterfall (a running total of +/- changes), histogram (counts of one series' values). Pie, doughnut, waterfall and histogram take one series.",
  },
  range: {
    ...chartRange,
    about:
      'Data to chart, read as Excel reads a selection: a header row names the series, a text or date first column labels the points, e.g. "A1:D13".',
  },
  categories: { ...chartRange, about: "Point labels, or a scatter's x values, for series." },
  series: {
    type: "list",
    min: 1,
    max: 12,
    about: "Data series, each its own options.",
    of: {
      type: "object",
      about: "One series.",
      fields: {
        values: chartRange,
        name: { ...chartText, about: 'Legend name: text, or "=B1" to follow a cell.' },
        sizes: { ...chartRange, about: "A bubble chart's sizes." },
        color: { type: "color", about: "Its colour; default the theme's next." },
        as: {
          type: "string",
          max: 6,
          options: ["column", "line", "area"],
          about: "In a column, line or area chart, draw this series as another of those (a combo).",
        },
        axis: {
          type: "string",
          max: 5,
          options: ["left", "right"],
          about: "Measure it on the right axis, for a second scale.",
        },
        labels: { type: "boolean", about: "Show its values on the points." },
        smooth: { type: "boolean", about: "A line drawn smooth." },
        markers: { type: "boolean", about: "A line with a dot on each point." },
        dashed: { type: "boolean", about: "A dashed line." },
        trendline: { type: "boolean", about: "A scatter's linear trendline." },
      },
      required: ["values"],
    },
  },
  stack: {
    type: "string",
    max: 7,
    options: ["none", "stacked", "percent"],
    about: "Column, bar or area: series side by side, stacked, or stacked to 100%.",
  },
  title: { ...chartText, about: 'Chart title: text, or "=A1" to follow a cell.' },
  subtitle: chartText,
  legend: {
    type: "string",
    max: 6,
    options: ["none", "top", "bottom", "left", "right"],
    about: "Where the legend goes.",
  },
  xAxis: axis(
    "Horizontal axis. Only a scatter's, bubble's or bar chart's takes min, max, format and log.",
  ),
  yAxis: axis("Vertical (left) axis."),
  rightAxis: axis('The right axis, for series with axis "right".'),
  labels: { type: "boolean", about: "Data labels on every series, or percents on a pie's slices." },
  hole: {
    type: "number",
    min: 0.1,
    max: 0.9,
    about: "A doughnut's hole, as a share of its radius.",
  },
  width: { type: "integer", min: 160, max: 2000, about: "Width in pixels (default 480)." },
  height: { type: "integer", min: 120, max: 1600, about: "Height in pixels (default 300)." },
} as const;

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
  setFormat: {
    ...setFormat,
    fields: {
      ...setFormat.fields,
      sheet,
      range,
      link: {
        type: "string",
        max: 2000,
        about:
          'A web or mail address the cells open, e.g. "https://example.com"; "none" removes it.',
      },
    },
  },
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
  group: {
    about:
      "Group rows or columns into an outline people can collapse, as Excel's Group; groups nest up to 7 deep. Give rows or columns. A group already on that span changes instead.",
    fields: {
      sheet,
      rows: { ...rows, about: 'The rows to group, e.g. "2:9".' },
      columns: { ...columns, about: 'The columns to group, e.g. "B:D".' },
      collapsed: { type: "boolean", about: "Collapse the group (true) or expand it (false)." },
      remove: { type: "boolean", about: "Ungroup that span instead." },
    },
    required: ["sheet"],
    change: ["grouped", "range"],
  },
  colorSheet: {
    about: "Colour a sheet's tab, or take its colour off.",
    fields: { sheet, color: { type: "color", about: "The tab's colour; leave out for none." } },
    required: ["sheet"],
    change: ["coloured", "sheet tab"],
  },
  deleteSheet: { ...SPREADSHEET_OPERATIONS.deleteSheet, fields: { sheet } },
  defineName: {
    ...SPREADSHEET_OPERATIONS.defineName,
    fields: { ...SPREADSHEET_OPERATIONS.defineName.fields, sheet, range },
  },
  addChart: {
    about:
      "Add a chart drawn from cells; it follows them as they change. Give range to read it as Excel reads a selection, or list series. Ranges may name another sheet, e.g. Data!B2:B13.",
    fields: {
      sheet: { ...sheet, about: "Sheet the chart is placed on." },
      at: { type: "cell", about: "Cell the chart's top-left corner sits on." },
      ...CHART_OPTIONS,
    },
    required: ["sheet", "at", "type"],
    exclusive: [["range", "series"]],
    change: ["added", "chart"],
  },
  editChart: {
    about:
      "Change a chart, by the id <charts> gives it. Only what is given changes; an axis given merges into the axis; series given replace them all.",
    fields: {
      chart: { type: "string", max: 64, about: "The chart's id." },
      clear: {
        type: "list",
        min: 1,
        max: 12,
        about: "Options to remove, back to their default.",
        of: { type: "string", max: 10, options: CLEARABLE, about: "An option." },
      },
      at: { type: "cell", about: "Move its top-left corner to this cell." },
      ...CHART_OPTIONS,
    },
    required: ["chart"],
    change: ["changed", "chart"],
  },
  setFilter: {
    about:
      "Put an AutoFilter on a range (its first row the headers) and, optionally, filter one column: keep listed shown values, or a condition. Rows that fail are hidden, not deleted.",
    fields: {
      sheet,
      range: {
        ...range,
        about: "The filter's range, headers first; default the existing filter's.",
      },
      column: { ...columns, about: 'The column to filter, e.g. "C".' },
      keep: {
        type: "list",
        min: 1,
        max: 200,
        about: 'Shown values to keep, as the cells show them; "" keeps empty cells.',
        of: { type: "string", max: 255, about: "A value." },
      },
      condition: {
        type: "string",
        max: 16,
        options: FILTER_CONDITIONS,
        about: "A test the column's value must pass.",
      },
      value: { type: "string", max: 255, about: "What the condition compares with." },
      clear: { type: "boolean", about: "Remove this column's filter instead." },
    },
    required: ["sheet"],
    change: ["filtered", "range"],
  },
  addConditionalFormat: {
    about:
      "Colour cells by their values, as Excel's conditional formatting: a highlight rule with a style (default light red fill, dark red text), a colour scale or data bars. A later rule never overrides an earlier one's style.",
    fields: {
      sheet,
      range,
      type: {
        type: "string",
        max: 14,
        options: [
          "greater",
          "less",
          "between",
          "equal",
          "notEqual",
          "textContains",
          "top",
          "bottom",
          "aboveAverage",
          "belowAverage",
          "duplicate",
          "unique",
          "blank",
          "colorScale",
          "dataBar",
        ],
        about: "The rule.",
      },
      value: {
        type: "string",
        max: 255,
        about: "What greater, less, between, equal, notEqual and textContains compare with.",
      },
      value2: { type: "string", max: 255, about: "between's upper bound." },
      count: {
        type: "integer",
        min: 1,
        max: 1000,
        about: "How many cells top and bottom take (default 10).",
      },
      percent: { type: "boolean", about: "count is a percent of the cells." },
      fill: { type: "color", about: "A highlight's fill." },
      fontColor: { type: "color", about: "A highlight's text colour." },
      bold: { type: "boolean", about: "A highlight's bold text." },
      colors: {
        type: "list",
        min: 2,
        max: 3,
        about: "A colour scale's colours, smallest value first.",
        of: { type: "color", about: "A colour." },
      },
      color: { type: "color", about: "A data bar's colour." },
    },
    required: ["sheet", "range", "type"],
    change: ["formatted", "range"],
  },
  clearConditionalFormats: {
    about: "Remove conditional formats: those touching a range, or every one on the sheet.",
    fields: { sheet, range: { ...range, about: "Only those touching this range." } },
    required: ["sheet"],
    change: ["cleared", "range"],
  },
  setValidation: {
    about:
      "Limit what a range's cells may hold, as Excel's Data Validation: a dropdown list, or a test on whole numbers, decimals, dates or text length. It replaces validations inside the range. People see a wrong entry refused or warned about; existing values are not changed.",
    fields: {
      sheet,
      range,
      type: {
        type: "string",
        max: 7,
        options: ["list", "whole", "decimal", "date", "length"],
        about: "What the cells may hold.",
      },
      choices: {
        type: "list",
        min: 1,
        max: 200,
        about: "A list's choices.",
        of: { type: "string", max: 255, about: "A choice." },
      },
      source: {
        type: "string",
        max: 100,
        about: 'A list read from cells instead of choices, e.g. "Lists!A2:A20".',
      },
      test: {
        type: "string",
        max: 14,
        options: VALIDATION_TESTS,
        about: "How a number, date or length compares with value (default between).",
      },
      value: {
        type: "string",
        max: 40,
        about: 'A number, or a date as "2026-01-31"; between\'s lower bound.',
      },
      value2: { type: "string", max: 40, about: "between and notBetween's upper bound." },
      onError: {
        type: "string",
        max: 11,
        options: ["stop", "warning", "information"],
        about: "What a wrong entry does: refused (default), kept after a warning, or a note.",
      },
      message: { type: "string", max: 255, about: "Said when a wrong entry is typed." },
      allowBlank: { type: "boolean", about: "Whether an empty cell passes (default true)." },
    },
    required: ["sheet", "range", "type"],
    change: ["validated", "range"],
  },
  clearValidation: {
    about: "Remove data validation: what touches a range, or every rule on the sheet.",
    fields: { sheet, range: { ...range, about: "Only rules touching this range." } },
    required: ["sheet"],
    change: ["cleared", "range"],
  },
  removeFilter: {
    about: "Remove a sheet's AutoFilter, showing every row it hid.",
    fields: { sheet },
    required: ["sheet"],
    change: ["removed", "filter"],
  },
  removeChart: {
    about: "Remove a chart, by the id the view gives it in <charts>.",
    fields: { chart: { type: "string", max: 64, about: "The chart's id." } },
    required: ["chart"],
    change: ["removed", "chart"],
  },
} as const satisfies Record<string, Definition>;

export type LiveSheetOperation = OperationOf<typeof LIVE_SHEET_OPERATIONS>;

const ONE_SERIES = new Set(["pie", "doughnut", "waterfall", "histogram"]);
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
      (kind === "addChart" || kind === "editChart") &&
      ONE_SERIES.has(operation.type as string) &&
      Array.isArray(operation.series) &&
      operation.series.length !== 1
    )
      fail(path, `a ${operation.type as string} chart takes exactly one series`);
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
