import { type BorderLine } from "@chat/sheet/style";
import {
  isFormulaValue,
  makeFormula,
  type Cell,
  type CellValue,
  type FormulaValue,
} from "@office-kit/xlsx/cell";
import { addChartAt, listChartsOnSheet, makeOneCellAnchor } from "@office-kit/xlsx/drawing";
import { fromArrayBuffer, loadWorkbook, workbookToBytes } from "@office-kit/xlsx/io";
import {
  getCellAlignment,
  getCellBorder,
  getCellDisplayText,
  getCellNumberFormat,
  makeBorder,
  makeFill,
  makeSide,
  patchCellFont,
  setCellAlignment,
  setCellBorder,
  setCellBorderAll,
  setCellFill,
  setCellNumberFormat,
  setRangeBorderBox,
} from "@office-kit/xlsx/styles";
import { OpenXmlError } from "@office-kit/xlsx/utils";
import {
  addDefinedName,
  addWorksheet,
  createWorkbook,
  getSheet,
  getSheetState,
  iterWorksheets,
  removeSheet,
  renameSheet,
  setFullCalcOnLoad,
  sheetNames,
  type Workbook,
} from "@office-kit/xlsx/workbook";
import {
  ensureCell,
  getAutoFilter,
  getCell,
  getFreezePanes,
  getMergedCells,
  getValueExtent,
  iterCells,
  listTables,
  makeAutoFilter,
  mergeCells,
  setAutoFilter,
  setCell,
  setColumnWidth,
  setFreezePanes,
  setRowHeight,
  unmergeCells,
  type Worksheet,
} from "@office-kit/xlsx/worksheet";
import { SpreadsheetError } from "../errors.ts";
import { SPREADSHEET_LIMITS } from "../limits.ts";
import {
  boxArea,
  boxRef,
  columnIndex,
  columnLetters,
  parseCell,
  parseRange,
  type CellBox,
} from "@chat/sheet/a1";
import { parseSpreadsheetOperations, type SpreadsheetOperation } from "../operations.ts";
import { recalculate, type CalcReport, type FormulaIssue } from "./calc.ts";
import {
  isDynamic,
  markDynamicArrays,
  prepareDynamicArrays,
  readDynamicCells,
} from "./dynamic-arrays.ts";
import { quoteSheet, renameSheetInFormula, shiftFormula, toFileFormula } from "./formulas.ts";
import { finishSeriesNames, refreshChartData, restoreSeriesNames } from "./chart-data.ts";
import { chartReference, type FileChart } from "./file-charts.ts";
import { OFFICE_THEME_XML } from "./office-theme.ts";
import { strToU8 } from "fflate";
import { readOfficePackage } from "../../office/server/package.ts";

const fail = (code: string, message: string): never => {
  throw new SpreadsheetError(code, message);
};

/** Formatting walks every cell of its range, so its area is bounded like writes are. */
const FORMAT_CELLS = 100_000;
const SPAN_ROWS = 10_000;
const CELL_TEXT = 300;

/**
 * Opens a workbook within the bounds, refusing what the app will not carry:
 * macros and embedded objects are active content, never run or passed on.
 */
export async function openWorkbook(bytes: Uint8Array): Promise<Workbook> {
  if (bytes.length > SPREADSHEET_LIMITS.compressedBytes)
    fail(
      "limit",
      `A workbook can be at most ${SPREADSHEET_LIMITS.compressedBytes / 1024 / 1024} MiB.`,
    );
  // The shared package checks first; the library then parses what passed them.
  readOfficePackage(bytes, {
    limits: {
      archiveBytes: SPREADSHEET_LIMITS.compressedBytes,
      entries: SPREADSHEET_LIMITS.parts,
      entryBytes: SPREADSHEET_LIMITS.expandedBytes,
      expandedBytes: SPREADSHEET_LIMITS.expandedBytes,
      expansionRatio: SPREADSHEET_LIMITS.expansionRatio,
    },
    fail: (kind) =>
      kind === "entries"
        ? fail("limit", `A workbook can have at most ${SPREADSHEET_LIMITS.parts} parts.`)
        : kind === "size"
          ? fail("limit", "This workbook expands past the size the app can open.")
          : fail("invalid_file", "This is not a workbook the app can open."),
  });
  let workbook: Workbook;
  try {
    const copy = bytes.slice().buffer;
    workbook = await loadWorkbook(fromArrayBuffer(copy), {
      decompressionLimits: {
        maxTotalUncompressedBytes: SPREADSHEET_LIMITS.expandedBytes,
        maxEntryUncompressedBytes: SPREADSHEET_LIMITS.expandedBytes,
      },
      contentLimits: { maxCells: SPREADSHEET_LIMITS.cells },
    });
  } catch (error) {
    if (error instanceof OpenXmlError)
      return fail(
        "invalid_file",
        `This is not a workbook the app can open: ${error.message.slice(0, 200)}`,
      );
    throw error;
  }
  restoreSeriesNames(workbook, bytes);
  if (workbook.vbaProject)
    fail(
      "unsupported_content",
      "Macro-enabled workbooks aren't supported; save it as .xlsx without macros.",
    );
  readDynamicCells(workbook, bytes);
  const worksheets = [...iterWorksheets(workbook)];
  if (worksheets.length > SPREADSHEET_LIMITS.sheets)
    fail("limit", `A workbook can have at most ${SPREADSHEET_LIMITS.sheets} sheets.`);
  for (const worksheet of worksheets)
    if (worksheet.oleObjects.length || worksheet.controls.length)
      fail(
        "unsupported_content",
        `Sheet "${worksheet.title}" contains embedded objects or form controls, which aren't supported.`,
      );
  return workbook;
}

/** Error codes a cell can store as plain text; Excel keeps newer ones (#SPILL!, #CALC!) as rich values. */
const STORABLE_ERRORS = new Set([
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#GETTING_DATA",
]);

/**
 * A newer error code written as a plain cached value makes Excel refuse the
 * whole file. Such a formula keeps no cached result, and readers of the file
 * calculate it again; a value it spilled is left empty the same way.
 */
function storableErrors(workbook: Workbook) {
  for (const sheet of iterWorksheets(workbook))
    for (const cell of iterCells(sheet)) {
      const value = cell.value;
      if (isFormulaValue(value)) {
        if (value.cachedValueType === "error" && !STORABLE_ERRORS.has(String(value.cachedValue))) {
          const { cachedValue: _value, cachedValueType: _type, ...formula } = value;
          cell.value = formula;
        }
      } else if (
        value &&
        typeof value === "object" &&
        !(value instanceof Date) &&
        value.kind === "error" &&
        !STORABLE_ERRORS.has(value.code)
      )
        cell.value = null;
    }
}

/** The workbook as file bytes: dynamic formulas marked, Excel set to recalculate on open. */
export async function workbookBytes(workbook: Workbook) {
  // Excel recomputes on open whatever the engine could not.
  setFullCalcOnLoad(workbook, true);
  // Without a theme every reader picks its own colours and fonts.
  workbook.themeXml ??= strToU8(OFFICE_THEME_XML);
  storableErrors(workbook);
  // Excel's calculation order would still list cells an edit removed, and Excel
  // repairs such a file; without one it builds its own.
  workbook.passthrough?.delete("xl/calcChain.xml");
  workbook.passthroughContentTypes?.delete("xl/calcChain.xml");
  if (workbook.workbookRelsExtras)
    workbook.workbookRelsExtras = workbook.workbookRelsExtras.filter(
      (rel) => !rel.type.endsWith("/calcChain"),
    );
  prepareDynamicArrays(workbook);
  refreshChartData(workbook);
  return finishSeriesNames(workbook, markDynamicArrays(workbook, await workbookToBytes(workbook)));
}

const save = async (workbook: Workbook) => {
  const bytes = await workbookBytes(workbook);
  if (bytes.length > SPREADSHEET_LIMITS.compressedBytes)
    fail("limit", "The edited workbook would exceed the size limit.");
  return bytes;
};

export async function createSpreadsheet() {
  const workbook = createWorkbook();
  addWorksheet(workbook, "Sheet1");
  return save(workbook);
}

export const sheetOf = (workbook: Workbook, name: string) =>
  getSheet(workbook, name) ??
  [...iterWorksheets(workbook)].find((sheet) => sheet.title.toLowerCase() === name.toLowerCase()) ??
  fail("not_found", `No sheet "${name}"; sheets: ${sheetNames(workbook).join(", ")}.`);

const rangeOf = (raw: string) =>
  parseRange(raw) ?? fail("invalid_operation", `"${raw}" is not a range.`);

/** A shared formula group's text lives only on its master; followers get their own. */
export function unshareFormulas(workbook: Workbook) {
  for (const sheet of iterWorksheets(workbook)) {
    const masters = new Map<number, { formula: string; row: number; column: number }>();
    const followers: Cell[] = [];
    for (const cell of iterCells(sheet)) {
      const value = cell.value;
      if (!isFormulaValue(value) || value.t !== "shared" || value.si === undefined) continue;
      if (value.formula)
        masters.set(value.si, { formula: value.formula, row: cell.row, column: cell.col });
      followers.push(cell);
    }
    for (const cell of followers) {
      const value = cell.value as FormulaValue;
      const master = masters.get(value.si!);
      if (!master) continue;
      cell.value = makeFormula(
        shiftFormula(master.formula, cell.row - master.row, cell.col - master.column),
        value.cachedValue === undefined
          ? {}
          : {
              cachedValue: value.cachedValue,
              ...(value.cachedValueType ? { cachedValueType: value.cachedValueType } : {}),
            },
      );
    }
  }
}

/** Array formula ranges on a sheet: their cells are owned by the formula. */
const arrayAreas = (workbook: Workbook, sheet: Worksheet) =>
  [...iterCells(sheet)].flatMap((cell) => {
    const value = cell.value;
    const box =
      isFormulaValue(value) && value.t === "array" && value.ref ? parseRange(value.ref) : null;
    return box ? [{ cell, box, dynamic: isDynamic(workbook, sheet, cell) }] : [];
  });

/**
 * Empties a dynamic formula's spilled cells, keeping its own. Writing into a
 * spill is allowed, as in Excel: the next calculation spills again, or shows
 * #SPILL! where something now stands in the way.
 */
function collapse(sheet: Worksheet, area: ReturnType<typeof arrayAreas>[number]) {
  for (const cell of cellsIn(sheet, area.box)) if (cell !== area.cell) cell.value = null;
  if (isFormulaValue(area.cell.value))
    area.cell.value = {
      ...area.cell.value,
      ref: boxRef({
        top: area.cell.row,
        left: area.cell.col,
        bottom: area.cell.row,
        right: area.cell.col,
      }),
    };
}
const overlaps = (a: CellBox, b: CellBox) =>
  a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;

const toCellValue = (input: string | number | boolean): CellValue => {
  if (typeof input !== "string") return input;
  if (input.startsWith("=") && input.length > 1) return makeFormula(toFileFormula(input));
  return input.startsWith("'") ? input.slice(1) : input;
};

const anchored = (row: number, column: number) => `$${columnLetters(column)}$${row}`;

/** A range written in a formula or chart: `Sheet!$A$1:$B$2`, the sheet defaulting to `sheet`. */
function absoluteRef(workbook: Workbook, raw: string, sheet: string) {
  const bang = raw.lastIndexOf("!");
  const name =
    bang === -1
      ? sheet
      : raw
          .slice(0, bang)
          .replace(/^'(.*)'$/, "$1")
          .replaceAll("''", "'");
  const target = sheetOf(workbook, name);
  const box = rangeOf(bang === -1 ? raw : raw.slice(bang + 1));
  const end =
    box.top === box.bottom && box.left === box.right ? "" : `:${anchored(box.bottom, box.right)}`;
  return `${quoteSheet(target.title)}!${anchored(box.top, box.left)}${end}`;
}

/** Existing cells of a box, without creating the empty ones. */
function* cellsIn(sheet: Worksheet, box: CellBox) {
  for (const [row, columns] of sheet.rows) {
    if (row < box.top || row > box.bottom) continue;
    for (const [column, cell] of columns) if (column >= box.left && column <= box.right) yield cell;
  }
}

/** Every cell of a box, created where missing so a style can land on it. */
function* everyCell(sheet: Worksheet, box: CellBox) {
  if (boxArea(box) > FORMAT_CELLS)
    fail("limit", `Format at most ${FORMAT_CELLS} cells per operation; ${boxRef(box)} is larger.`);
  for (let row = box.top; row <= box.bottom; row++)
    for (let column = box.left; column <= box.right; column++) yield ensureCell(sheet, row, column);
}

const span = (raw: string, parse: (part: string) => number) => {
  const [from, to = from] = raw.split(":").map(parse) as [number, number?];
  return [Math.min(from, to!), Math.max(from, to!)] as const;
};

/** Every reference to a renamed sheet, in formulas, names and charts. */
function renameReferences(workbook: Workbook, from: string, to: string) {
  for (const sheet of iterWorksheets(workbook))
    for (const cell of iterCells(sheet)) {
      const value = cell.value;
      if (isFormulaValue(value) && value.formula)
        cell.value = { ...value, formula: renameSheetInFormula(value.formula, from, to) };
    }
  workbook.definedNames = workbook.definedNames.map((name) => ({
    ...name,
    value: renameSheetInFormula(name.value, from, to),
  }));
  // Chart data is addressed by `ref` strings wherever the chart kind keeps them.
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node))
      if (key === "ref" && typeof child === "string")
        (node as Record<string, unknown>)[key] = renameSheetInFormula(child, from, to);
      else walk(child);
  };
  for (const sheet of iterWorksheets(workbook))
    for (const item of listChartsOnSheet(sheet)) walk(item);
}

/** An addChart operation as the file chart it makes. */
const fileChartOf = (
  operation: Omit<Extract<SpreadsheetOperation, { kind: "addChart" }>, "kind">,
): FileChart => ({
  sheet: operation.sheet,
  at: operation.at,
  width: operation.width ?? 480,
  height: operation.height ?? 300,
  // The schema offers only the kinds a file chart has.
  kind: operation.type as FileChart["kind"],
  ...(operation.title ? { title: operation.title } : {}),
  // Below the plot, where Excel puts a new chart's legend.
  ...(operation.series.length > 1 || operation.type === "pie" ? { legend: "bottom" } : {}),
  series: operation.series.map((item) => ({
    values: item.values,
    ...(operation.categories ? { categories: operation.categories } : {}),
    ...(item.name ? { name: { text: item.name } } : {}),
  })),
});

/** Places a file chart on its sheet, its ranges made absolute against the workbook. */
function placeChart(workbook: Workbook, chart: FileChart) {
  const item = addChartAt(
    sheetOf(workbook, chart.sheet),
    chart.at,
    chartReference(chart, (ref) => absoluteRef(workbook, ref, chart.sheet)),
    { widthPx: chart.width, heightPx: chart.height },
  );
  const corner = parseCell(chart.at);
  // Excel keeps how far into its cell a chart's corner sits as offsets in EMUs.
  if (chart.offset && corner)
    item.anchor = makeOneCellAnchor({
      from: {
        col: corner.column - 1,
        row: corner.row - 1,
        colOff: Math.round(chart.offset.x * 9_525),
        rowOff: Math.round(chart.offset.y * 9_525),
      },
      widthPx: chart.width,
      heightPx: chart.height,
    });
}

/** Applies one operation; a failure names it and nothing of the batch is saved. */
/** A cell the batch wrote, by sheet object so a later rename in the batch keeps it. */
type Written = { readonly sheet: Worksheet; readonly row: number; readonly column: number };

function apply(workbook: Workbook, operation: SpreadsheetOperation, written: Written[]) {
  switch (operation.kind) {
    case "setCells": {
      const sheet = sheetOf(workbook, operation.sheet);
      const start = parseCell(operation.start)!;
      const width = Math.max(...operation.rows.map((row) => row.length));
      const box = {
        top: start.row,
        left: start.column,
        bottom: start.row + operation.rows.length - 1,
        right: start.column + width - 1,
      };
      for (const area of arrayAreas(workbook, sheet).filter((each) => overlaps(each.box, box))) {
        if (!area.dynamic)
          fail(
            "invalid_operation",
            `${boxRef(box)} overlaps the array formula at ${boxRef(area.box)}; clear it first.`,
          );
        collapse(sheet, area);
      }
      const merges = getMergedCells(sheet).map((merge) => ({
        top: merge.minRow,
        left: merge.minCol,
        bottom: merge.maxRow,
        right: merge.maxCol,
      }));
      operation.rows.forEach((row, rowOffset) =>
        row.forEach((input, columnOffset) => {
          const rowIndex = start.row + rowOffset;
          const column = start.column + columnOffset;
          const hidden = merges.find(
            (merge) =>
              overlaps(merge, { top: rowIndex, left: column, bottom: rowIndex, right: column }) &&
              (merge.top !== rowIndex || merge.left !== column),
          );
          if (hidden && input !== null)
            fail(
              "invalid_operation",
              `${columnLetters(column)}${rowIndex} is inside merged range ${boxRef(hidden)}; write to its top-left cell.`,
            );
          const existing = getCell(sheet, rowIndex, column);
          if (input === null) {
            if (existing) existing.value = null;
            return;
          }
          setCell(sheet, rowIndex, column, toCellValue(input), existing?.styleId);
          written.push({ sheet, row: rowIndex, column });
        }),
      );
      return;
    }
    case "clearRange": {
      const sheet = sheetOf(workbook, operation.sheet);
      const box = rangeOf(operation.range);
      // Clearing an array formula's own cell clears everything it filled.
      for (const area of arrayAreas(workbook, sheet))
        if (
          overlaps(area.box, box) &&
          (area.dynamic ||
            (box.top <= area.cell.row &&
              area.cell.row <= box.bottom &&
              box.left <= area.cell.col &&
              area.cell.col <= box.right))
        )
          collapse(sheet, area);
      for (const cell of cellsIn(sheet, box)) cell.value = null;
      return;
    }
    case "setFormat": {
      const sheet = sheetOf(workbook, operation.sheet);
      const box = rangeOf(operation.range);
      const pen = sideOf({
        style: operation.borderStyle ?? "thin",
        ...(operation.borderColor && operation.borderColor !== "none"
          ? { color: operation.borderColor }
          : {}),
      });
      for (const cell of everyCell(sheet, box)) {
        const font = {
          ...(operation.bold === undefined ? {} : { bold: operation.bold }),
          ...(operation.italic === undefined ? {} : { italic: operation.italic }),
          ...(operation.underline === undefined
            ? {}
            : { underline: operation.underline ? ("single" as const) : undefined }),
          ...(operation.strike === undefined ? {} : { strike: operation.strike }),
          ...(operation.font ? { name: operation.font } : {}),
          ...(operation.fontSize === undefined ? {} : { size: operation.fontSize }),
          ...(operation.fontColor ? { color: { rgb: `FF${operation.fontColor.slice(1)}` } } : {}),
        };
        if (Object.keys(font).length) patchCellFont(workbook, cell, font);
        if (operation.fill)
          setCellFill(
            workbook,
            cell,
            operation.fill === "none"
              ? makeFill({ patternType: "none" })
              : makeFill({
                  patternType: "solid",
                  fgColor: { rgb: `FF${operation.fill.slice(1)}` },
                }),
          );
        if (operation.numberFormat) setCellNumberFormat(workbook, cell, operation.numberFormat);
        if (operation.horizontal || operation.vertical || operation.wrap !== undefined)
          setCellAlignment(workbook, cell, {
            ...getCellAlignment(workbook, cell),
            ...(operation.horizontal
              ? { horizontal: operation.horizontal as "left" | "center" | "right" }
              : {}),
            ...(operation.vertical
              ? { vertical: operation.vertical as "top" | "center" | "bottom" }
              : {}),
            ...(operation.wrap === undefined ? {} : { wrapText: operation.wrap }),
          });
        if (operation.border === "all") setCellBorderAll(workbook, cell, pen);
        if (operation.border === "none")
          setCellBorderAll(workbook, cell, { style: "none" as "thin" });
        // One edge of the range: the cells along it keep their other sides.
        const edge =
          operation.border === "top" && cell.row === box.top
            ? "top"
            : operation.border === "bottom" && cell.row === box.bottom
              ? "bottom"
              : null;
        if (edge)
          setCellBorder(
            workbook,
            cell,
            makeBorder({ ...getCellBorder(workbook, cell), [edge]: makeSide(pen) }),
          );
      }
      if (operation.border === "outline") setRangeBorderBox(workbook, sheet, boxRef(box), pen);
      return;
    }
    case "setColumnWidth": {
      const sheet = sheetOf(workbook, operation.sheet);
      const [from, to] = span(operation.columns, columnIndex);
      for (let column = from; column <= to; column++)
        setColumnWidth(sheet, column, operation.width);
      return;
    }
    case "setRowHeight": {
      const sheet = sheetOf(workbook, operation.sheet);
      const [from, to] = span(operation.rows, Number);
      if (to - from + 1 > SPAN_ROWS) fail("limit", `Set at most ${SPAN_ROWS} row heights at once.`);
      for (let row = from; row <= to; row++) setRowHeight(sheet, row, operation.height);
      return;
    }
    case "mergeCells":
      mergeCells(sheetOf(workbook, operation.sheet), boxRef(rangeOf(operation.range)));
      return;
    case "unmergeCells":
      if (!unmergeCells(sheetOf(workbook, operation.sheet), boxRef(rangeOf(operation.range))))
        fail("not_found", `${operation.range} is not a merged range.`);
      return;
    case "freezePanes":
      setFreezePanes(
        sheetOf(workbook, operation.sheet),
        operation.cell === "A1" ? undefined : operation.cell,
      );
      return;
    case "setAutoFilter":
      setAutoFilter(
        sheetOf(workbook, operation.sheet),
        operation.range === "none"
          ? undefined
          : makeAutoFilter({ ref: boxRef(rangeOf(operation.range)) }),
      );
      return;
    case "addSheet":
      if (
        [...iterWorksheets(workbook)].some(
          (sheet) => sheet.title.toLowerCase() === operation.name.toLowerCase(),
        )
      )
        fail("invalid_operation", `A sheet named "${operation.name}" already exists.`);
      if (sheetNames(workbook).length >= SPREADSHEET_LIMITS.sheets)
        fail("limit", `A workbook can have at most ${SPREADSHEET_LIMITS.sheets} sheets.`);
      addWorksheet(workbook, operation.name);
      return;
    case "renameSheet": {
      const sheet = sheetOf(workbook, operation.sheet);
      if (
        operation.name.toLowerCase() !== sheet.title.toLowerCase() &&
        [...iterWorksheets(workbook)].some(
          (each) => each.title.toLowerCase() === operation.name.toLowerCase(),
        )
      )
        fail("invalid_operation", `A sheet named "${operation.name}" already exists.`);
      const from = sheet.title;
      renameSheet(workbook, from, operation.name);
      renameReferences(workbook, from, operation.name);
      return;
    }
    case "deleteSheet": {
      const sheet = sheetOf(workbook, operation.sheet);
      if (sheetNames(workbook).length <= 1)
        fail("invalid_operation", "A workbook keeps at least one sheet.");
      removeSheet(workbook, sheet.title);
      return;
    }
    case "defineName":
      addDefinedName(workbook, {
        name: operation.name,
        value: absoluteRef(workbook, operation.range, operation.sheet),
      });
      return;
    case "addChart": {
      const sheet = sheetOf(workbook, operation.sheet);
      if (listChartsOnSheet(sheet).length >= SPREADSHEET_LIMITS.chartsPerSheet)
        fail("limit", `A sheet can hold at most ${SPREADSHEET_LIMITS.chartsPerSheet} charts.`);
      placeChart(workbook, fileChartOf(operation));
      return;
    }
  }
}

const clip = (text: string) => (text.length > CELL_TEXT ? `${text.slice(0, CELL_TEXT)}…` : text);

/** One cell as the model reads it: what Excel shows, and the formula behind it. */
function describeCell(workbook: Workbook, cell: Cell) {
  const value = cell.value;
  const format = getCellNumberFormat(workbook, cell);
  return {
    cell: `${columnLetters(cell.col)}${cell.row}`,
    value: clip(getCellDisplayText(workbook, cell)),
    ...(isFormulaValue(value) && value.formula ? { formula: `=${clip(value.formula)}` } : {}),
    ...(format && format !== "General" ? { format } : {}),
  };
}

export interface InspectScope {
  readonly sheet?: string;
  readonly range?: string;
}

const formulaErrors = (workbook: Workbook) => {
  const errors: FormulaIssue[] = [];
  let count = 0;
  for (const sheet of iterWorksheets(workbook))
    for (const cell of iterCells(sheet)) {
      const value = cell.value;
      if (!isFormulaValue(value) || value.cachedValueType !== "error") continue;
      count += 1;
      if (errors.length < SPREADSHEET_LIMITS.errorsListed)
        errors.push({
          cell: `${sheet.title}!${columnLetters(cell.col)}${cell.row}`,
          error: String(value.cachedValue),
        });
    }
  return { errors, errorCount: count };
};

/** Sheets at a glance plus one bounded window of cells the model asked for. */
function inspection(workbook: Workbook, scope: InspectScope, calc?: CalcReport) {
  const worksheets = [...iterWorksheets(workbook)];
  const sheets = worksheets.map((sheet) => {
    const extent = getValueExtent(sheet);
    return {
      name: sheet.title,
      ...(getSheetState(workbook, sheet.title) === "visible" ? {} : { hidden: true }),
      usedRange: extent
        ? boxRef({
            top: extent.minRow,
            left: extent.minCol,
            bottom: extent.maxRow,
            right: extent.maxCol,
          })
        : null,
      ...(getFreezePanes(sheet) ? { frozenAt: getFreezePanes(sheet) } : {}),
      ...(getAutoFilter(sheet) ? { filter: getAutoFilter(sheet)!.ref } : {}),
      merged: getMergedCells(sheet)
        .slice(0, 20)
        .map((merge) =>
          boxRef({
            top: merge.minRow,
            left: merge.minCol,
            bottom: merge.maxRow,
            right: merge.maxCol,
          }),
        ),
      tables: listTables(sheet).map((table) => ({ name: table.displayName, range: table.ref })),
      charts: listChartsOnSheet(sheet).length,
    };
  });
  const target = scope.sheet
    ? sheetOf(workbook, scope.sheet)
    : (worksheets.find((sheet) => getSheetState(workbook, sheet.title) === "visible") ??
      worksheets[0]);
  let window: ReturnType<typeof windowOf> | null = null;
  if (target) window = windowOf(workbook, target, scope.range);
  const { errors, errorCount } = calc ?? formulaErrors(workbook);
  return {
    sheets,
    names: workbook.definedNames
      .filter((name) => !name.name.startsWith("_xlnm."))
      .slice(0, 50)
      .map((name) => ({ name: name.name, refersTo: name.value })),
    window,
    formulaErrors: { count: errorCount, cells: errors },
    ...(calc?.unsupported.length ? { notCalculated: calc.unsupported } : {}),
  };
}

function windowOf(workbook: Workbook, sheet: Worksheet, range?: string) {
  const extent = getValueExtent(sheet);
  const asked = range ? rangeOf(range) : null;
  const box: CellBox | null =
    asked ??
    (extent
      ? { top: extent.minRow, left: extent.minCol, bottom: extent.maxRow, right: extent.maxCol }
      : null);
  if (!box) return { sheet: sheet.title, range: null, cells: [], truncated: false };
  const cells: Array<ReturnType<typeof describeCell>> = [];
  let truncated = false;
  let bottom = box.bottom;
  const ordered = [...cellsIn(sheet, box)]
    .filter((cell) => cell.value !== null && cell.value !== "")
    .toSorted((a, b) => a.row - b.row || a.col - b.col);
  for (const cell of ordered) {
    if (cells.length >= SPREADSHEET_LIMITS.windowCells) {
      truncated = true;
      bottom = cells.at(-1) ? Number(/\d+$/.exec(cells.at(-1)!.cell)![0]) : box.top;
      break;
    }
    cells.push(describeCell(workbook, cell));
  }
  return {
    sheet: sheet.title,
    range: boxRef({ ...box, bottom }),
    cells,
    // The rest of the asked range: read it with another inspect_spreadsheet.
    truncated,
  };
}

/**
 * Calculates the results a file was saved without, for reading only. What the
 * file stored is kept as stored: Excel may have computed it differently, and
 * a reader is shown the file, not our engine's view of it. Undefined when
 * every result was there.
 */
export function calculateMissing(workbook: Workbook) {
  const stored: { sheet: Worksheet; row: number; col: number; value: Cell["value"] }[] = [];
  let missing = false;
  for (const sheet of iterWorksheets(workbook))
    for (const cell of iterCells(sheet)) {
      const value = cell.value;
      if (
        isFormulaValue(value) &&
        (value.t === "normal" || value.t === "array") &&
        value.cachedValue === undefined
      )
        missing = true;
      else if (value !== null) stored.push({ sheet, row: cell.row, col: cell.col, value });
    }
  if (!missing) return undefined;
  const report = recalculate(workbook);
  for (const each of stored) {
    const cell = getCell(each.sheet, each.row, each.col);
    if (cell) cell.value = each.value;
  }
  return report;
}

export async function inspectSpreadsheet(bytes: Uint8Array, scope: InspectScope = {}) {
  const workbook = await openWorkbook(bytes);
  // A file another program wrote without results is calculated for reading only.
  const calc = calculateMissing(workbook);
  return inspection(workbook, scope, calc);
}

export async function editSpreadsheet(bytes: Uint8Array, rawOperations: unknown) {
  const operations = parseSpreadsheetOperations(rawOperations);
  const workbook = await openWorkbook(bytes);
  unshareFormulas(workbook);
  const written: Written[] = [];
  for (const [index, operation] of operations.entries())
    try {
      apply(workbook, operation, written);
    } catch (error) {
      if (error instanceof SpreadsheetError)
        throw new SpreadsheetError(
          error.code,
          `operations[${index}] ${operation.kind}: ${error.message}`,
        );
      throw new SpreadsheetError(
        "invalid_operation",
        `operations[${index}] ${operation.kind}: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}`,
      );
    }
  // Formulas written now follow Excel 365; the file's own keep the semantics they were saved with.
  const authored = new Set(
    written.flatMap(({ sheet, row, column }) => {
      const cell = getCell(sheet, row, column);
      return cell && isFormulaValue(cell.value) ? [cell] : [];
    }),
  );
  const calc = recalculate(workbook, { authored });
  if (calc.formulas > SPREADSHEET_LIMITS.formulas)
    fail("limit", `A workbook can have at most ${SPREADSHEET_LIMITS.formulas} formulas.`);
  // What the batch computed, so the model sees results without another read.
  const present = new Set(iterWorksheets(workbook));
  const results = written
    .filter(({ sheet }) => present.has(sheet))
    .flatMap(({ sheet, row, column }) => {
      const cell = getCell(sheet, row, column);
      return cell && isFormulaValue(cell.value)
        ? [{ sheet: sheet.title, ...describeCell(workbook, cell) }]
        : [];
    })
    .slice(0, SPREADSHEET_LIMITS.errorsListed);
  return {
    bytes: await save(workbook),
    cellsWritten: written.length,
    formulaResults: results,
    formulaErrors: { count: calc.errorCount, cells: calc.errors },
    ...(calc.unsupported.length ? { notCalculated: calc.unsupported } : {}),
    sheets: sheetNames(workbook),
    operations: operations.map((operation) => operation.kind),
  };
}

/** An edge's line as the file writes it: colour as ARGB, black where none is set. */
const sideOf = (line: BorderLine) => ({
  style: line.style,
  ...(line.color ? { color: { rgb: `FF${line.color.slice(1)}` } } : {}),
});
