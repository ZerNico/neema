import {
  operationEngine,
  received,
  xmlSafe,
  type Definition as OfficeDefinition,
} from "../office/operations.ts";
import { MAX_COLUMN, MAX_ROW, columnIndex, parseCell, parseRange } from "@chat/sheet/a1";
import { SpreadsheetError } from "./errors.ts";
import { SPREADSHEET_LIMITS } from "./limits.ts";

/**
 * The one description of every spreadsheet edit. Validation, the JSON schema
 * the model is offered, the adapter's operation types and the activity's
 * change summary all derive from this table, as for every Office family.
 */
type OwnField = {
  readonly type: "sheet" | "cell" | "range" | "columns" | "rowSpan" | "color" | "rows";
  readonly about: string;
};
export type Definition = OfficeDefinition<OwnField>;

export const sheet = {
  type: "sheet",
  about: "Sheet name, exactly as inspect_spreadsheet lists it.",
} as const;
export const range = {
  type: "range",
  about: 'A cell or rectangle on the sheet, e.g. "B2" or "A1:D20".',
} as const;

export const SPREADSHEET_OPERATIONS = {
  setCells: {
    about:
      'Write values starting at one cell: rows[0] fills the start row left to right, rows[1] the next. A string starting with "=" is a formula (e.g. "=SUM(B2:B9)"); start with an apostrophe to write text that begins with "=". null clears a cell.',
    fields: {
      sheet,
      start: { type: "cell", about: 'Top-left cell, e.g. "A1".' },
      rows: {
        type: "rows",
        about: "Rows of values: numbers, text, true/false, null, or formulas.",
      },
    },
    required: ["sheet", "start", "rows"],
    change: ["wrote", "cell range"],
  },
  clearRange: {
    about: "Remove the values and formulas in a range; formatting stays.",
    fields: { sheet, range },
    required: ["sheet", "range"],
    change: ["cleared", "range"],
  },
  setFormat: {
    about: "Format every cell in a range. Give only the properties to change.",
    fields: {
      sheet,
      range,
      bold: { type: "boolean", about: "Bold text." },
      italic: { type: "boolean", about: "Italic text." },
      underline: { type: "boolean", about: "Underlined text." },
      strike: { type: "boolean", about: "Struck-through text." },
      font: { type: "string", max: 60, about: 'Font name, e.g. "Calibri" or "Georgia".' },
      fontSize: { type: "number", min: 6, max: 72, about: "Font size in points." },
      fontColor: { type: "color", about: "Text colour as #RRGGBB." },
      fill: { type: "color", about: 'Background colour as #RRGGBB, or "none".' },
      numberFormat: {
        type: "string",
        max: 100,
        about: 'Excel number format, e.g. "#,##0.00", "0%", "yyyy-mm-dd" or "General".',
      },
      horizontal: {
        type: "string",
        max: 10,
        options: ["left", "center", "right"],
        about: "Horizontal alignment.",
      },
      vertical: {
        type: "string",
        max: 10,
        options: ["top", "center", "bottom"],
        about: "Vertical alignment.",
      },
      wrap: { type: "boolean", about: "Wrap long text inside the cell." },
      border: {
        type: "string",
        max: 10,
        options: ["all", "outline", "top", "bottom", "none"],
        about: "Borders on every cell, around the range, along its top or bottom edge, or none.",
      },
      borderStyle: {
        type: "string",
        max: 10,
        options: ["thin", "medium", "thick", "dashed", "dotted", "double"],
        about: 'The border\'s line, thin by default; e.g. "double" under a total.',
      },
      borderColor: { type: "color", about: "The border's colour as #RRGGBB; black by default." },
    },
    required: ["sheet", "range"],
    change: ["formatted", "range"],
  },
  setColumnWidth: {
    about: "Set the width of one or more columns, in characters.",
    fields: {
      sheet,
      columns: { type: "columns", about: 'A column or span, e.g. "B" or "A:D".' },
      width: { type: "number", min: 1, max: 255, about: "Width in characters." },
    },
    required: ["sheet", "columns", "width"],
    change: ["resized", "column"],
  },
  setRowHeight: {
    about: "Set the height of one or more rows, in points.",
    fields: {
      sheet,
      rows: { type: "rowSpan", about: 'A row or span, e.g. "1" or "2:10".' },
      height: { type: "number", min: 1, max: 409, about: "Height in points." },
    },
    required: ["sheet", "rows", "height"],
    change: ["resized", "row"],
  },
  mergeCells: {
    about: "Merge a range into one cell; the top-left value is kept.",
    fields: { sheet, range },
    required: ["sheet", "range"],
    change: ["merged", "range"],
  },
  unmergeCells: {
    about: "Split a merged range back into cells.",
    fields: { sheet, range },
    required: ["sheet", "range"],
    change: ["split", "merged range"],
  },
  freezePanes: {
    about:
      'Keep rows above and columns left of a cell visible while scrolling, e.g. "A2" freezes the first row. "A1" removes freezing.',
    fields: { sheet, cell: { type: "cell", about: "First scrolling cell." } },
    required: ["sheet", "cell"],
    change: ["froze", "pane"],
  },
  setAutoFilter: {
    about: 'Add filter buttons to a header row and the data under it; "none" removes them.',
    fields: {
      sheet,
      range: { type: "range", about: 'The header row and data, e.g. "A1:F200", or "none".' },
    },
    required: ["sheet", "range"],
    change: ["set", "filter"],
  },
  addSheet: {
    about: "Add an empty sheet at the end.",
    fields: { name: { ...sheet, about: "New sheet name, at most 31 characters." } },
    required: ["name"],
    change: ["added", "sheet"],
  },
  renameSheet: {
    about: "Rename a sheet. Formulas that name it are updated.",
    fields: { sheet, name: { ...sheet, about: "New name." } },
    required: ["sheet", "name"],
    change: ["renamed", "sheet"],
  },
  deleteSheet: {
    about: "Delete a sheet. Formulas that used it show #REF!.",
    fields: { sheet },
    required: ["sheet"],
    change: ["deleted", "sheet"],
  },
  defineName: {
    about: "Name a range so formulas can use it, e.g. =SUM(Sales).",
    fields: {
      name: {
        type: "string",
        max: 100,
        about: "A name starting with a letter; letters, digits, _ and . only.",
      },
      sheet,
      range,
    },
    required: ["name", "sheet", "range"],
    change: ["named", "range"],
  },
  addChart: {
    about:
      "Add a chart drawn from cells on the workbook. Categories label the points; each series is one line, bar set or pie.",
    fields: {
      sheet: { ...sheet, about: "Sheet the chart is placed on." },
      type: {
        type: "string",
        max: 10,
        options: ["column", "bar", "line", "area", "pie", "scatter"],
        about: "Chart type. Pie takes exactly one series.",
      },
      at: { type: "cell", about: "Cell the chart's top-left corner sits on." },
      title: { type: "string", max: 200, about: "Chart title." },
      categories: {
        type: "string",
        max: 100,
        about: 'Category labels or x values, e.g. "Data!A2:A13".',
      },
      series: {
        type: "list",
        min: 1,
        max: 12,
        about: "Data series.",
        of: {
          type: "object",
          about: "One series.",
          fields: {
            values: { type: "string", max: 100, about: 'Values, e.g. "Data!B2:B13".' },
            name: { type: "string", max: 100, about: "Legend name." },
          },
          required: ["values"],
        },
      },
      width: { type: "integer", min: 200, max: 1600, about: "Width in pixels (default 480)." },
      height: { type: "integer", min: 150, max: 1200, about: "Height in pixels (default 300)." },
    },
    required: ["sheet", "type", "at", "series"],
    change: ["added", "chart"],
  },
} as const satisfies Record<string, Definition>;

type Catalog = typeof SPREADSHEET_OPERATIONS;
export type SpreadsheetOperationKind = keyof Catalog;
export type CellInput = string | number | boolean | null;

type ValueOf<F> = F extends { type: "integer" | "number" }
  ? number
  : F extends { type: "boolean" }
    ? boolean
    : F extends { type: "rows" }
      ? CellInput[][]
      : F extends { type: "list"; of: infer I }
        ? ValueOf<I>[]
        : F extends { type: "object"; fields: infer Fs; required: readonly (infer R)[] }
          ? Shape<Fs, R>
          : F extends { options: readonly (infer O)[] }
            ? O
            : string;
type Shape<Fs, R> = { -readonly [K in keyof Fs & R]: ValueOf<Fs[K]> } & {
  -readonly [K in Exclude<keyof Fs, R>]?: ValueOf<Fs[K]>;
};
/** One operation of a catalog, typed from its table. */
export type OperationOf<T extends Record<string, Definition>> = {
  [K in keyof T & string]: { kind: K } & Shape<T[K]["fields"], T[K]["required"][number]>;
}[keyof T & string];
export type SpreadsheetOperation = OperationOf<Catalog>;

const COLUMN = /^[A-Z]{1,3}$/;
const ROW = /^[1-9]\d{0,6}$/;

const sheetNameProblem = (name: string) =>
  name.length === 0 || name.length > 31
    ? "a sheet name is 1–31 characters"
    : /[[\]:*?/\\]/.test(name)
      ? "a sheet name cannot contain [ ] : * ? / \\"
      : name.startsWith("'") || name.endsWith("'")
        ? "a sheet name cannot start or end with an apostrophe"
        : [...name].some((character) => character.charCodeAt(0) < 32)
          ? "a sheet name cannot contain control characters"
          : null;

const describe = (field: OwnField) => {
  switch (field.type) {
    case "sheet":
      return "a sheet name";
    case "cell":
      return 'a cell like "B2"';
    case "range":
      return 'a cell or range like "A1:D9"';
    case "columns":
      return 'a column or span like "B" or "A:D"';
    case "rowSpan":
      return 'a row or span like "3" or "2:10"';
    case "color":
      return "a #RRGGBB colour";
    case "rows":
      return "a list of rows, each a list of values";
  }
};

const fail = (path: string, message: string): never => {
  throw new SpreadsheetError("invalid_operation", `${path}: ${message}`);
};

function cellInput(raw: unknown, path: string): CellInput {
  if (raw === null || typeof raw === "boolean") return raw;
  if (typeof raw === "number")
    return Number.isFinite(raw) ? raw : fail(path, "not a finite number");
  if (typeof raw !== "string") return fail(path, `expected a value; received ${received(raw)}`);
  if (!xmlSafe(raw)) return fail(path, "text contains control characters");
  const limit = raw.startsWith("=")
    ? SPREADSHEET_LIMITS.formulaChars
    : SPREADSHEET_LIMITS.textChars;
  if (raw.length > limit) return fail(path, `longer than Excel's ${limit} characters`);
  return raw;
}

function value(field: OwnField, raw: unknown, path: string, wrong: () => never): unknown {
  switch (field.type) {
    case "sheet": {
      if (typeof raw !== "string") return wrong();
      const problem = sheetNameProblem(raw);
      return problem ? fail(path, problem) : raw;
    }
    case "cell":
      return typeof raw === "string" && parseCell(raw) ? raw.trim().toUpperCase() : wrong();
    case "range":
      if (raw === "none" && path.endsWith("setAutoFilter.range")) return raw;
      return typeof raw === "string" && parseRange(raw) ? raw.trim().toUpperCase() : wrong();
    case "columns": {
      const parts = typeof raw === "string" ? raw.trim().toUpperCase().split(":") : [];
      return parts.length >= 1 &&
        parts.length <= 2 &&
        parts.every((part) => COLUMN.test(part) && columnIndex(part) <= MAX_COLUMN)
        ? parts.join(":")
        : wrong();
    }
    case "rowSpan": {
      const text = typeof raw === "number" ? String(raw) : raw;
      const parts = typeof text === "string" ? text.trim().split(":") : [];
      return parts.length >= 1 &&
        parts.length <= 2 &&
        parts.every((part) => ROW.test(part) && Number(part) <= MAX_ROW)
        ? parts.join(":")
        : wrong();
    }
    case "color":
      if (raw === "none" && path.endsWith(".fill")) return raw;
      return typeof raw === "string" && /^#?[0-9a-f]{6}$/i.test(raw)
        ? `#${raw.replace(/^#/, "").toUpperCase()}`
        : wrong();
    case "rows": {
      if (!Array.isArray(raw) || raw.length === 0) return wrong();
      // One row given flat is the common near miss.
      const rows = raw.every((row) => !Array.isArray(row)) ? [raw] : raw;
      return rows.map((row, index) =>
        Array.isArray(row)
          ? row.map((item, column) => cellInput(item, `${path}[${index}][${column}]`))
          : fail(
              `${path}[${index}]`,
              `expected a row (a list of values); received ${received(row)}`,
            ),
      );
    }
  }
}

/** The engine for a table of spreadsheet operations: the Excel tools' or a live sheet's. */
export const spreadsheetEngine = (
  operations: Readonly<Record<string, Definition>>,
  maxOperations: number,
) =>
  operationEngine({
    operations,
    maxOperations,
    Error: SpreadsheetError,
    own: {
      describe,
      value: (field, raw, path, _stage, wrong) => value(field, raw, path, wrong),
      schema: (field) =>
        field.type === "rows"
          ? {
              type: "array",
              description: field.about,
              items: {
                type: "array",
                items: { type: ["string", "number", "boolean", "null"] },
              },
            }
          : { type: "string", description: field.about },
    },
  });
const engine = spreadsheetEngine(SPREADSHEET_OPERATIONS, SPREADSHEET_LIMITS.operationsPerCall);

/** Validates a batch before any worker opens the workbook. */
export function parseSpreadsheetOperations(input: unknown): SpreadsheetOperation[] {
  let cells = 0;
  const operations = engine.parse(input, undefined, (kind, operation, path) => {
    if (kind === "setCells") {
      const start = parseCell(operation.start as string)!;
      const rows = operation.rows as CellInput[][];
      const width = Math.max(...rows.map((row) => row.length));
      if (start.row + rows.length - 1 > MAX_ROW || start.column + width - 1 > MAX_COLUMN)
        fail(path, "the values run past the last row or column of a sheet");
      cells += rows.reduce((sum, row) => sum + row.length, 0);
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
  if (cells > SPREADSHEET_LIMITS.cellsPerCall)
    fail(
      "operations",
      `at most ${SPREADSHEET_LIMITS.cellsPerCall} cells per call; received ${cells}. Split into smaller calls; no edits were applied`,
    );
  // The table's fields were each checked above; the type is the table's.
  return operations as SpreadsheetOperation[];
}

/** The operations parameter as the model sees it: one branch per kind. */
export const spreadsheetOperationsJsonSchema = engine.jsonSchema;

/** "Wrote 2 cell ranges and added a chart", from operation kinds alone, for people. */
export const describeSpreadsheetChanges: (operations: readonly SpreadsheetOperation[]) => string =
  engine.describeChanges;
