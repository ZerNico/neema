import { isChart, isChartPatch, type ChartPatch } from "./chart.ts";
import type { Axis, Box, CellAnchor, CellValue, Chart, Formula } from "./model.ts";

/**
 * What changes a sheet document, addressed by IDs. Copying and filling are
 * not operations: whoever copies computes the cells (see `copyFormula`) and
 * sends them as a `set`. Cut (`move`) and `sort` are, because they redirect
 * or shift formulas across the document.
 */

/** A rectangle by IDs; a null pair spans every row or every column. */
export interface Area {
  readonly r1: string | null;
  readonly r2: string | null;
  readonly c1: string | null;
  readonly c2: string | null;
}

/** One cell's new content: a value, a formula, or neither to clear it. */
export interface CellWrite {
  readonly r: string;
  readonly c: string;
  readonly v?: CellValue | null;
  readonly f?: Formula;
  readonly array?: { readonly rows: number; readonly cols: number };
}

/** Style properties; null removes one. */
export type StylePatch = Readonly<Record<string, string | number | boolean | null>>;

export type SheetOp =
  | { readonly op: "set"; readonly sh: string; readonly cells: readonly CellWrite[] }
  | {
      readonly op: "clear";
      readonly sh: string;
      readonly area: Area;
      readonly what: "contents" | "formats" | "all";
    }
  | { readonly op: "format"; readonly sh: string; readonly area: Area; readonly patch: StylePatch }
  | {
      readonly op: "resize";
      readonly sh: string;
      readonly axis: Axis;
      readonly ids: readonly string[];
      readonly size: number | null;
    }
  | {
      readonly op: "hide";
      readonly sh: string;
      readonly axis: Axis;
      readonly ids: readonly string[];
      readonly hidden: boolean;
    }
  | {
      readonly op: "insert";
      readonly sh: string;
      readonly axis: Axis;
      readonly ids: readonly string[];
      /** Inserted after this entry, dead or alive; null inserts at the start. */
      readonly after: string | null;
    }
  | {
      readonly op: "delete" | "revive";
      readonly sh: string;
      readonly axis: Axis;
      readonly ids: readonly string[];
    }
  | { readonly op: "merge" | "unmerge"; readonly sh: string; readonly box: Box }
  | {
      readonly op: "freeze";
      readonly sh: string;
      readonly row: string | null;
      readonly col: string | null;
    }
  | {
      readonly op: "sheetAdd";
      readonly id: string;
      readonly name: string;
      readonly after: string | null;
      /** The new sheet's row and column IDs, minted by whoever adds it. */
      readonly rows: readonly string[];
      readonly cols: readonly string[];
    }
  | { readonly op: "sheetRename"; readonly id: string; readonly name: string }
  | { readonly op: "sheetMove"; readonly id: string; readonly after: string | null }
  | { readonly op: "sheetDelete" | "sheetRevive"; readonly id: string }
  | { readonly op: "name"; readonly name: string; readonly f: Formula | null }
  | { readonly op: "settings"; readonly locale?: string; readonly timeZone?: string }
  | { readonly op: "chartPut"; readonly id: string; readonly chart: Chart }
  | { readonly op: "chartPatch"; readonly id: string; readonly patch: ChartPatch }
  | { readonly op: "chartDelete"; readonly id: string }
  | {
      readonly op: "anchor";
      readonly thread: string;
      readonly at: CellAnchor | null;
    }
  | {
      readonly op: "move";
      readonly sh: string;
      readonly box: Box;
      /** The target's top-left cell, on `toSh` (default: the same sheet). */
      readonly to: { readonly sh?: string; readonly r: string; readonly c: string };
    }
  | {
      readonly op: "sort";
      readonly sh: string;
      readonly c1: string;
      readonly c2: string;
      /** The rows of the range, top to bottom, as the sorter saw them. */
      readonly rows: readonly string[];
      /** The same rows in their new order: `order[i]`'s content goes to `rows[i]`. */
      readonly order: readonly string[];
    };

/** One revision: who sent it, their sequence number (for dedup), and its operations. */
export interface SheetChange {
  readonly clientId: string;
  readonly seq: number;
  readonly ops: readonly SheetOp[];
}

const OP_NAMES = new Set([
  "set",
  "clear",
  "format",
  "resize",
  "hide",
  "insert",
  "delete",
  "revive",
  "merge",
  "unmerge",
  "freeze",
  "sheetAdd",
  "sheetRename",
  "sheetMove",
  "sheetDelete",
  "sheetRevive",
  "name",
  "settings",
  "chartPut",
  "chartPatch",
  "chartDelete",
  "anchor",
  "move",
  "sort",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 64;
const isIdOrNull = (value: unknown) => value === null || isId(value);
const isIds = (value: unknown) =>
  Array.isArray(value) && value.length <= 100_000 && value.every(isId);
const isAxis = (value: unknown) => value === "rows" || value === "columns";
const isBox = (value: unknown) =>
  isRecord(value) && isId(value.r1) && isId(value.r2) && isId(value.c1) && isId(value.c2);
const isArea = (value: unknown) =>
  isRecord(value) &&
  isIdOrNull(value.r1) &&
  isIdOrNull(value.r2) &&
  isIdOrNull(value.c1) &&
  isIdOrNull(value.c2);

const isCorner = (value: unknown) =>
  isRecord(value) &&
  isIdOrNull(value.row) &&
  isIdOrNull(value.col) &&
  typeof value.rowAbs === "boolean" &&
  typeof value.colAbs === "boolean";
const isFormula = (value: unknown) =>
  isRecord(value) &&
  Array.isArray(value.parts) &&
  value.parts.every(
    (part) =>
      typeof part === "string" ||
      (isRecord(part) &&
        ((part.k === "ref" &&
          isIdOrNull(part.sheet) &&
          isCorner(part.from) &&
          (part.to === null || isCorner(part.to))) ||
          (part.k === "span" &&
            isId(part.first) &&
            isId(part.last) &&
            typeof part.area === "string"))),
  );
const isValue = (value: unknown) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
const isPatch = (value: unknown) =>
  isRecord(value) &&
  Object.values(value).every(
    (each) =>
      each === null ||
      typeof each === "boolean" ||
      typeof each === "string" ||
      (typeof each === "number" && Number.isFinite(each)),
  );

function validOp(op: Record<string, unknown>): boolean {
  switch (op.op) {
    case "set":
      return (
        isId(op.sh) &&
        Array.isArray(op.cells) &&
        op.cells.every(
          (cell) =>
            isRecord(cell) &&
            isId(cell.r) &&
            isId(cell.c) &&
            (cell.v === undefined || isValue(cell.v)) &&
            (cell.f === undefined || isFormula(cell.f)),
        )
      );
    case "clear":
      return (
        isId(op.sh) && isArea(op.area) && ["contents", "formats", "all"].includes(op.what as string)
      );
    case "format":
      return isId(op.sh) && isArea(op.area) && isPatch(op.patch);
    case "resize":
      return (
        isId(op.sh) &&
        isAxis(op.axis) &&
        isIds(op.ids) &&
        (op.size === null || (typeof op.size === "number" && op.size >= 0 && op.size <= 2000))
      );
    case "hide":
      return isId(op.sh) && isAxis(op.axis) && isIds(op.ids) && typeof op.hidden === "boolean";
    case "insert":
      return isId(op.sh) && isAxis(op.axis) && isIds(op.ids) && isIdOrNull(op.after);
    case "delete":
    case "revive":
      return isId(op.sh) && isAxis(op.axis) && isIds(op.ids);
    case "merge":
    case "unmerge":
      return isId(op.sh) && isBox(op.box);
    case "freeze":
      return isId(op.sh) && isIdOrNull(op.row) && isIdOrNull(op.col);
    case "sheetAdd":
      return (
        isId(op.id) &&
        typeof op.name === "string" &&
        isIdOrNull(op.after) &&
        isIds(op.rows) &&
        isIds(op.cols)
      );
    case "sheetRename":
      return isId(op.id) && typeof op.name === "string";
    case "sheetMove":
      return isId(op.id) && isIdOrNull(op.after);
    case "sheetDelete":
    case "sheetRevive":
    case "chartDelete":
      return isId(op.id);
    case "name":
      return typeof op.name === "string" && (op.f === null || isFormula(op.f));
    case "chartPut":
      return isId(op.id) && isChart(op.chart);
    case "chartPatch":
      return isId(op.id) && isChartPatch(op.patch);
    case "settings":
      return (
        (op.locale === undefined || (typeof op.locale === "string" && op.locale.length <= 20)) &&
        (op.timeZone === undefined || (typeof op.timeZone === "string" && op.timeZone.length <= 64))
      );
    case "anchor":
      return (
        isId(op.thread) &&
        (op.at === null ||
          (isRecord(op.at) &&
            isId(op.at.sh) &&
            isId(op.at.r) &&
            isId(op.at.c) &&
            (op.at.r2 === undefined || isId(op.at.r2)) &&
            (op.at.c2 === undefined || isId(op.at.c2))))
      );
    case "move":
      return (
        isId(op.sh) &&
        isBox(op.box) &&
        isRecord(op.to) &&
        isId(op.to.r) &&
        isId(op.to.c) &&
        (op.to.sh === undefined || isId(op.to.sh))
      );
    case "sort":
      return isId(op.sh) && isId(op.c1) && isId(op.c2) && isIds(op.rows) && isIds(op.order);
    default:
      return false;
  }
}

/** Why a change from the wire is malformed, or null when every operation checks out. */
function problem(input: unknown): string | null {
  if (
    !isRecord(input) ||
    !isId(input.clientId) ||
    !Number.isSafeInteger(input.seq) ||
    !Array.isArray(input.ops)
  )
    return "a change needs clientId, seq and ops";
  for (const [index, op] of input.ops.entries()) {
    if (!isRecord(op) || !OP_NAMES.has(op.op as string)) return `op ${index} is not an operation`;
    if (!validOp(op)) return `op ${index} (${String(op.op)}) is malformed`;
  }
  return null;
}
const isChange = (input: unknown): input is SheetChange => problem(input) === null;

/** A change from the wire, checked field by field; the transport's schema calls this. */
export function parseChange(
  input: unknown,
): { ok: true; change: SheetChange } | { ok: false; error: string } {
  return isChange(input) ? { ok: true, change: input } : { ok: false, error: problem(input)! };
}
