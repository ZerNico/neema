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
  getCellFill,
  getCellFont,
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
  getColumnDimension,
  getFreezePanes,
  getMergedCells,
  getRowDimension,
  getValueExtent,
  iterCells,
  listComments,
  listDataValidations,
  listTables,
  hideColumn,
  hideRow,
  makeAutoFilter,
  makeFilterColumn,
  mergeCells,
  setAutoFilter,
  setCell,
  setColumnWidth,
  setFreezePanes,
  setRowHeight,
  unmergeCells,
  type Worksheet,
  makeHyperlink,
  makeSheetProperties,
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
import { recalculate, scalarOf, type CalcReport, type FormulaIssue } from "./calc.ts";
import { XError } from "@chat/sheet/engine/values";
import {
  isDynamic,
  markDynamicArrays,
  prepareDynamicArrays,
  readDynamicCells,
} from "./dynamic-arrays.ts";
import { quoteSheet, renameSheetInFormula, shiftFormula, toFileFormula } from "./formulas.ts";
import { finishSeriesNames, refreshChartData, restoreSeriesNames } from "./chart-data.ts";
import { chartReference, readFileChart, type FileChart } from "./file-charts.ts";
import { readValidation, writeValidations, type FileValidation } from "./file-validation.ts";
import { NOTE_LIMITS, readNote, writeNotes, type FileNote } from "./file-notes.ts";
import {
  fileHighlightStyles,
  readConditional,
  writeConditionals,
  type FileConditional,
} from "./file-conditional.ts";
import { sheetChart, sheetCharts } from "./chart-parts.ts";
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

const sheetOf = (workbook: Workbook, name: string) =>
  getSheet(workbook, name) ??
  [...iterWorksheets(workbook)].find((sheet) => sheet.title.toLowerCase() === name.toLowerCase()) ??
  fail("not_found", `No sheet "${name}"; sheets: ${sheetNames(workbook).join(", ")}.`);

const rangeOf = (raw: string) =>
  parseRange(raw) ?? fail("invalid_operation", `"${raw}" is not a range.`);

/** A shared formula group's text lives only on its master; followers get their own. */
function unshareFormulas(workbook: Workbook) {
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
        if (operation.border === "all") setCellBorderAll(workbook, cell, { style: "thin" });
        if (operation.border === "none")
          setCellBorderAll(workbook, cell, { style: "none" as "thin" });
      }
      if (operation.border === "outline")
        setRangeBorderBox(workbook, sheet, boxRef(box), { style: "thin" });
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

const needsCalculation = (workbook: Workbook) => {
  for (const sheet of iterWorksheets(workbook))
    for (const cell of iterCells(sheet)) {
      const value = cell.value;
      if (
        isFormulaValue(value) &&
        (value.t === "normal" || value.t === "array") &&
        value.cachedValue === undefined
      )
        return true;
    }
  return false;
};

export async function inspectSpreadsheet(bytes: Uint8Array, scope: InspectScope = {}) {
  const workbook = await openWorkbook(bytes);
  // A file another program wrote without results is calculated for reading only.
  const calc = needsCalculation(workbook) ? recalculate(workbook) : undefined;
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

/** A live sheet as a workbook is built from it: every cell's input as setCells takes it, and its style. */
export interface LiveSheetExport {
  readonly sheets: ReadonlyArray<{
    readonly name: string;
    readonly cells: ReadonlyArray<{
      readonly row: number;
      readonly column: number;
      readonly input?: string | number | boolean;
      readonly style?: Readonly<Record<string, string | number | boolean>>;
    }>;
    readonly merges: readonly string[];
    readonly widths: ReadonlyArray<readonly [column: number, characters: number]>;
    readonly heights: ReadonlyArray<readonly [row: number, points: number]>;
    readonly freeze?: string;
    readonly hiddenRows?: readonly number[];
    readonly hiddenCols?: readonly number[];
    readonly filter?: FileFilter;
    readonly conditional?: readonly FileConditional[];
    readonly validations?: readonly FileValidation[];
    /** The tab's colour, as #RRGGBB. */
    readonly color?: string;
    /** Cell notes, each a comment thread. */
    readonly notes?: readonly FileNote[];
  }>;
  readonly names: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Charts by sheet name and cell, their ranges as A1 text. */
  readonly charts?: readonly FileChart[];
}

/** An AutoFilter as a file keeps one: its range, and the values each filtered column keeps. */
export interface FileFilter {
  readonly ref: string;
  /** By column counted from the filter's first, 0-based; `blank` keeps empty cells too. */
  readonly columns: ReadonlyArray<{
    readonly col: number;
    readonly values: readonly string[];
    readonly blank: boolean;
  }>;
}

/** Excel's Hyperlink style colour, which a linked cell takes unless it has its own. */
const LINK_COLOR = "#0563C1";
/** A link a file may carry: web and mail addresses only. */
const fileLink = (text: unknown) =>
  typeof text === "string" && /^(https?:\/\/|mailto:)/i.test(text) && text.length <= 2079
    ? text
    : null;

/** A live sheet's style properties, as the `format` operation stores them, on one cell. */
function styleCell(workbook: Workbook, cell: Cell, style: Readonly<Record<string, unknown>>) {
  const text = (key: string) => (typeof style[key] === "string" ? (style[key] as string) : null);
  const font = {
    ...(style.bold === true ? { bold: true } : {}),
    ...(style.italic === true ? { italic: true } : {}),
    ...(style.underline === true ? { underline: "single" as const } : {}),
    ...(style.strike === true ? { strike: true } : {}),
    ...(text("fontFamily") ? { name: text("fontFamily")! } : {}),
    ...(typeof style.fontSize === "number" ? { size: style.fontSize } : {}),
    ...(text("fontColor") ? { color: { rgb: `FF${text("fontColor")!.slice(1)}` } } : {}),
  };
  if (Object.keys(font).length) patchCellFont(workbook, cell, font);
  if (text("fill"))
    setCellFill(
      workbook,
      cell,
      makeFill({ patternType: "solid", fgColor: { rgb: `FF${text("fill")!.slice(1)}` } }),
    );
  if (text("numberFormat")) setCellNumberFormat(workbook, cell, text("numberFormat")!);
  const horizontal = text("horizontal");
  const vertical = text("vertical");
  if (horizontal || vertical || style.wrap === true)
    setCellAlignment(workbook, cell, {
      ...(horizontal ? { horizontal: horizontal as "left" | "center" | "right" } : {}),
      ...(vertical ? { vertical: vertical as "top" | "center" | "bottom" } : {}),
      ...(style.wrap === true ? { wrapText: true } : {}),
    });
  const side = makeSide({ style: "thin" });
  const edges = {
    ...(style.borderTop === true ? { top: side } : {}),
    ...(style.borderBottom === true ? { bottom: side } : {}),
    ...(style.borderLeft === true ? { left: side } : {}),
    ...(style.borderRight === true ? { right: side } : {}),
  };
  if (Object.keys(edges).length) setCellBorder(workbook, cell, makeBorder(edges));
}

/**
 * A workbook made from a live sheet. Its formulas are written as Excel 365
 * reads them and calculated here, so the file opens with every value.
 */
export async function exportLiveSheet(spec: LiveSheetExport) {
  const workbook = createWorkbook();
  const authored = new Set<Cell>();
  for (const each of spec.sheets) {
    const sheet = addWorksheet(workbook, each.name);
    for (const { row, column, input, style } of each.cells) {
      if (input !== undefined) {
        setCell(sheet, row, column, toCellValue(input));
        const cell = getCell(sheet, row, column);
        if (cell && isFormulaValue(cell.value)) authored.add(cell);
      }
      const link = fileLink(style?.link);
      // A link is Excel's hyperlink on the cell, looking as Excel's Hyperlink style does.
      // A target the file format refuses leaves the cell's text without its link.
      if (link)
        try {
          sheet.hyperlinks.push(
            makeHyperlink({ ref: `${columnLetters(column)}${row}`, target: link }),
          );
        } catch {
          // Kept as text.
        }
      if (style)
        styleCell(
          workbook,
          ensureCell(sheet, row, column),
          link ? { ...style, underline: true, fontColor: style.fontColor ?? LINK_COLOR } : style,
        );
    }
    for (const merge of each.merges) mergeCells(sheet, merge);
    for (const [column, width] of each.widths) setColumnWidth(sheet, column, width);
    for (const [row, height] of each.heights) setRowHeight(sheet, row, height);
    if (each.freeze) setFreezePanes(sheet, each.freeze);
    if (each.conditional?.length) writeConditionals(workbook, sheet, each.conditional);
    if (each.validations?.length) writeValidations(sheet, each.validations);
    if (each.notes?.length) writeNotes(sheet, each.notes);
    if (each.color)
      sheet.sheetProperties = makeSheetProperties({
        ...sheet.sheetProperties,
        tabColor: { rgb: `FF${each.color.slice(1).toUpperCase()}` },
      });
    for (const row of each.hiddenRows ?? []) hideRow(sheet, row);
    for (const column of each.hiddenCols ?? []) hideColumn(sheet, column);
    if (each.filter)
      setAutoFilter(
        sheet,
        makeAutoFilter({
          ref: each.filter.ref,
          filterColumns: each.filter.columns.map((column) =>
            makeFilterColumn({ colId: column.col, values: column.values, blank: column.blank }),
          ),
        }),
      );
  }
  for (const name of spec.names) addDefinedName(workbook, name);
  for (const chart of spec.charts ?? []) placeChart(workbook, chart);
  recalculate(workbook, { authored });
  return save(workbook);
}

/** A workbook read for a live sheet: what it keeps by position, and what it leaves behind. */
export interface LiveSheetImport {
  readonly sheets: ReadonlyArray<{
    readonly name: string;
    readonly rows: number;
    readonly cols: number;
    readonly cells: ReadonlyArray<{
      readonly row: number;
      readonly column: number;
      /** A value, or a formula as typed (with "="). */
      readonly value?: string | number | boolean;
      readonly formula?: string;
      /** A legacy array formula's extent; a dynamic one spills by itself. */
      readonly array?: { readonly rows: number; readonly cols: number };
      readonly style?: Readonly<Record<string, string | number | boolean>>;
    }>;
    readonly merges: readonly string[];
    readonly widths: ReadonlyArray<readonly [column: number, characters: number]>;
    readonly heights: ReadonlyArray<readonly [row: number, points: number]>;
    readonly freeze?: string;
    readonly hiddenRows?: readonly number[];
    readonly hiddenCols?: readonly number[];
    readonly filter?: FileFilter;
    readonly conditional?: readonly FileConditional[];
    readonly validations?: readonly FileValidation[];
    /** The tab's colour, as #RRGGBB. */
    readonly color?: string;
    /** Cell notes, each a comment thread. */
    readonly notes?: readonly FileNote[];
  }>;
  readonly names: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly charts: readonly FileChart[];
  /** What a live sheet does not keep, in words, for the model to tell the person. */
  readonly dropped: readonly string[];
}

/** Fonts Excel and its readers start a workbook with; a cell in one keeps no font of its own. */
const DEFAULT_FONTS = new Set(["Calibri", "Aptos", "Aptos Narrow", "Arial"]);
const rgbOf = (color: { rgb?: string } | undefined) =>
  color?.rgb && /^[0-9a-f]{8}$/i.test(color.rgb) ? `#${color.rgb.slice(2).toUpperCase()}` : null;

/** A linked cell's style: its link, without the look Excel's Hyperlink style gave it. */
function linkedStyle(style: Record<string, string | number | boolean> | undefined, link: string) {
  const { underline: _, fontColor, ...rest } = style ?? {};
  return { ...rest, ...(fontColor && fontColor !== LINK_COLOR ? { fontColor } : {}), link };
}

/** A cell's style as a live sheet stores it: only what its format operation knows. */
function liveStyle(workbook: Workbook, cell: Cell) {
  const style: Record<string, string | number | boolean> = {};
  const font = getCellFont(workbook, cell);
  if (font.bold) style.bold = true;
  if (font.italic) style.italic = true;
  if (font.underline) style.underline = true;
  if (font.strike) style.strike = true;
  // The workbook's default font is the sheet's own; only another is kept.
  if (font.name && !DEFAULT_FONTS.has(font.name)) style.fontFamily = font.name;
  if (font.size && font.size !== 11) style.fontSize = font.size;
  const fontColor = rgbOf(font.color);
  if (fontColor && fontColor !== "#000000") style.fontColor = fontColor;
  const fill = getCellFill(workbook, cell);
  const fillColor =
    fill.kind === "pattern" && fill.patternType === "solid" ? rgbOf(fill.fgColor) : null;
  if (fillColor) style.fill = fillColor;
  const format = getCellNumberFormat(workbook, cell);
  if (format && format !== "General") style.numberFormat = format;
  const alignment = getCellAlignment(workbook, cell);
  if (
    alignment.horizontal === "left" ||
    alignment.horizontal === "center" ||
    alignment.horizontal === "right"
  )
    style.horizontal = alignment.horizontal;
  if (
    alignment.vertical === "top" ||
    alignment.vertical === "center" ||
    alignment.vertical === "bottom"
  )
    style.vertical = alignment.vertical;
  if (alignment.wrapText) style.wrap = true;
  const border = getCellBorder(workbook, cell);
  for (const [side, key] of [
    ["top", "borderTop"],
    ["bottom", "borderBottom"],
    ["left", "borderLeft"],
    ["right", "borderRight"],
  ] as const)
    if (border[side]?.style && border[side].style !== "none") style[key] = true;
  return Object.keys(style).length ? style : undefined;
}

/**
 * Reads a workbook for a live sheet: cells by position with their values,
 * formulas as text and styles, and sizes, merges, panes and names. What a
 * live sheet cannot hold is listed in `dropped`, never guessed at.
 */
export async function importLiveSheet(bytes: Uint8Array): Promise<LiveSheetImport> {
  const workbook = await openWorkbook(bytes);
  unshareFormulas(workbook);
  const dropped = new Set<string>();
  const charts: FileChart[] = [];
  const highlightStyles = fileHighlightStyles(bytes);
  const sheets = [...iterWorksheets(workbook)].map((sheet) => {
    const cells: Array<LiveSheetImport["sheets"][number]["cells"][number]> = [];
    let [rows, cols] = [0, 0];
    // Hyperlinks by cell; one over a range links each of its cells.
    const links = new Map<string, string>();
    for (const hyperlink of sheet.hyperlinks) {
      const link = fileLink(hyperlink.target);
      const box = parseRange(hyperlink.ref);
      if (!link || !box) {
        dropped.add("links within the workbook or to files");
        continue;
      }
      for (let row = box.top; row <= Math.min(box.bottom, box.top + 999); row++)
        for (let col = box.left; col <= Math.min(box.right, box.left + 99); col++)
          links.set(`${row}:${col}`, link);
    }
    for (const cell of iterCells(sheet)) {
      const value = cell.value;
      const link = links.get(`${cell.row}:${cell.col}`);
      const style = link ? linkedStyle(liveStyle(workbook, cell), link) : liveStyle(workbook, cell);
      let entry: LiveSheetImport["sheets"][number]["cells"][number] | null = null;
      if (isFormulaValue(value)) {
        if (value.t === "array" && value.ref && !isDynamic(workbook, sheet, cell)) {
          const box = parseRange(value.ref);
          entry = {
            row: cell.row,
            column: cell.col,
            formula: value.formula,
            ...(box
              ? { array: { rows: box.bottom - box.top + 1, cols: box.right - box.left + 1 } }
              : {}),
          };
        } else if (value.formula)
          entry = { row: cell.row, column: cell.col, formula: value.formula };
      } else {
        const scalar = scalarOf(value);
        if (scalar instanceof XError)
          entry = { row: cell.row, column: cell.col, value: scalar.code };
        else if (scalar !== null) entry = { row: cell.row, column: cell.col, value: scalar };
      }
      if (!entry && !style) continue;
      cells.push({
        ...(entry ?? { row: cell.row, column: cell.col }),
        ...(style ? { style } : {}),
      });
      rows = Math.max(rows, cell.row);
      cols = Math.max(cols, cell.col);
    }
    const merges = getMergedCells(sheet).map((merge) =>
      boxRef({ top: merge.minRow, left: merge.minCol, bottom: merge.maxRow, right: merge.maxCol }),
    );
    const widths: Array<[number, number]> = [];
    for (let column = 1; column <= Math.max(cols, 26); column++) {
      const width = getColumnDimension(sheet, column)?.width;
      if (width !== undefined) widths.push([column, width]);
    }
    const heights: Array<[number, number]> = [];
    for (let row = 1; row <= rows; row++) {
      const height = getRowDimension(sheet, row);
      if (height?.customHeight && height.height !== undefined) heights.push([row, height.height]);
    }
    for (const item of listChartsOnSheet(sheet)) {
      const chart = readFileChart(sheet.title, item);
      if (chart) charts.push(chart);
      else dropped.add("charts of kinds a live sheet does not draw");
    }
    if (listTables(sheet).length) dropped.add("table formatting (the data stays)");
    const autoFilter = getAutoFilter(sheet);
    const filter: FileFilter | undefined = autoFilter
      ? {
          ref: autoFilter.ref,
          columns: autoFilter.filterColumns.flatMap((column) =>
            column.kind === "filters"
              ? [{ col: column.colId, values: column.values, blank: !!column.blank }]
              : [],
          ),
        }
      : undefined;
    // Rows Excel hid for its filter are the filter's to hide again, not hidden by hand.
    const filterBox = filter?.columns.length ? parseRange(filter.ref) : null;
    const hiddenRows: number[] = [];
    // Empty rows may be hidden too: as far down as a new live sheet reaches.
    for (let row = 1; row <= Math.max(rows, 1_000); row++)
      if (
        getRowDimension(sheet, row)?.hidden &&
        !(filterBox && row > filterBox.top && row <= filterBox.bottom)
      )
        hiddenRows.push(row);
    const tabColor = rgbOf(sheet.sheetProperties?.tabColor);
    const hiddenCols: number[] = [];
    for (let column = 1; column <= Math.max(cols, 26); column++)
      if (getColumnDimension(sheet, column)?.hidden) hiddenCols.push(column);
    const conditional = sheet.conditionalFormatting
      .flatMap((format) =>
        format.rules
          .toSorted((a, b) => a.priority - b.priority)
          .flatMap((rule) => {
            const range = format.sqref.ranges[0];
            const read = range ? readConditional(rule, highlightStyles) : null;
            if (!range || !read) {
              dropped.add(
                "conditional formats of kinds a live sheet does not draw (icon sets, formulas)",
              );
              return [];
            }
            const ref = boxRef({
              top: range.minRow,
              left: range.minCol,
              bottom: range.maxRow,
              right: range.maxCol,
            });
            return [{ ref, rule: read, priority: rule.priority }];
          }),
      )
      .toSorted((a, b) => a.priority - b.priority)
      .map(({ ref, rule }) => ({ ref, rule }));
    const validations = listDataValidations(sheet).flatMap((validation) => {
      const range = validation.sqref.ranges[0];
      const read = range
        ? readValidation(
            validation,
            boxRef({
              top: range.minRow,
              left: range.minCol,
              bottom: range.maxRow,
              right: range.maxCol,
            }),
          )
        : null;
      if (!read)
        dropped.add("data validation of kinds a live sheet does not check (times, formulas)");
      return read ? [read] : [];
    });
    const notes = listComments(sheet)
      .slice(0, NOTE_LIMITS.notes)
      .flatMap((note) => readNote(note) ?? []);
    const freeze = getFreezePanes(sheet);
    return {
      name: sheet.title,
      rows,
      cols,
      cells,
      merges,
      widths,
      heights,
      ...(freeze ? { freeze } : {}),
      ...(hiddenRows.length ? { hiddenRows } : {}),
      ...(hiddenCols.length ? { hiddenCols } : {}),
      ...(filter ? { filter } : {}),
      ...(conditional.length ? { conditional } : {}),
      ...(validations.length ? { validations } : {}),
      ...(tabColor ? { color: tabColor } : {}),
      ...(notes.length ? { notes } : {}),
    };
  });
  return {
    sheets,
    names: workbook.definedNames
      .filter((name) => !name.name.startsWith("_xlnm."))
      .map((name) => ({ name: name.name, value: name.value })),
    charts,
    dropped: [...dropped],
  };
}

export interface PreviewCell {
  readonly text: string;
  readonly bold?: true;
  readonly italic?: true;
  readonly color?: string;
  readonly fill?: string;
  readonly align?: "left" | "center" | "right";
}
const hex = (rgb: string | undefined) =>
  rgb && /^[0-9a-f]{8}$/i.test(rgb) ? `#${rgb.slice(2).toUpperCase()}` : undefined;

/**
 * What a person sees of one sheet: displayed text and the few styles a grid
 * shows, from A1, bounded. Colours are plain hex; nothing here is markup.
 */
export async function previewSpreadsheet(bytes: Uint8Array, sheetName?: string) {
  const workbook = await openWorkbook(bytes);
  if (needsCalculation(workbook)) recalculate(workbook);
  const worksheets = [...iterWorksheets(workbook)];
  // The first sheet a person would see: hidden ones have no tab.
  const sheet = sheetName
    ? sheetOf(workbook, sheetName)
    : (worksheets.find((each) => getSheetState(workbook, each.title) === "visible") ??
      worksheets[0]);
  if (!sheet) return fail("not_found", "The workbook has no sheets.");
  const extent = getValueExtent(sheet);
  const rows = Math.min(extent?.maxRow ?? 0, SPREADSHEET_LIMITS.previewRows);
  const columns = Math.min(extent?.maxCol ?? 0, SPREADSHEET_LIMITS.previewColumns);
  const grid: (PreviewCell | null)[][] = [];
  for (let row = 1; row <= rows; row++) {
    const line: (PreviewCell | null)[] = [];
    for (let column = 1; column <= columns; column++) {
      const cell = getCell(sheet, row, column);
      if (!cell) {
        line.push(null);
        continue;
      }
      const font = getCellFont(workbook, cell);
      const fill = getCellFill(workbook, cell);
      const align = getCellAlignment(workbook, cell).horizontal;
      const fillColor =
        fill.kind === "pattern" && fill.patternType === "solid"
          ? hex(fill.fgColor?.rgb)
          : undefined;
      const fontColor = hex(font.color?.rgb);
      line.push({
        text: clip(getCellDisplayText(workbook, cell)),
        ...(font.bold ? { bold: true as const } : {}),
        ...(font.italic ? { italic: true as const } : {}),
        ...(fontColor ? { color: fontColor } : {}),
        ...(fillColor ? { fill: fillColor } : {}),
        ...(align === "left" || align === "center" || align === "right" ? { align } : {}),
      });
    }
    grid.push(line);
  }
  return {
    sheets: worksheets.map((each) => ({
      name: each.title,
      ...(getSheetState(workbook, each.title) === "visible" ? {} : { hidden: true }),
    })),
    sheet: sheet.title,
    rows: grid,
    columnWidths: Array.from(
      { length: columns },
      (_, index) => getColumnDimension(sheet, index + 1)?.width ?? null,
    ),
    merged: getMergedCells(sheet)
      .filter((merge) => merge.minRow <= rows && merge.minCol <= columns)
      .map((merge) =>
        boxRef({
          top: merge.minRow,
          left: merge.minCol,
          // Clipped to the window: a whole-sheet merge would otherwise
          // send the client 17 billion cells to cover.
          bottom: Math.min(merge.maxRow, rows),
          right: Math.min(merge.maxCol, columns),
        }),
      ),
    // Drawn ones are fetched one by one; the rest are only counted. The model
    // reads charts however their XML is written, so its count is the floor.
    ...(({ charts, others }) => ({
      charts: charts.length,
      otherCharts: Math.max(others, listChartsOnSheet(sheet).length - charts.length),
    }))(sheetCharts(bytes, sheet)),
    truncated: (extent?.maxRow ?? 0) > rows || (extent?.maxCol ?? 0) > columns,
  };
}
export type SpreadsheetPreview = Awaited<ReturnType<typeof previewSpreadsheet>>;

/** One chart of a sheet, as stored, for the preview to draw. */
export async function previewChart(
  bytes: Uint8Array,
  sheetName: string | undefined,
  index: number,
) {
  const workbook = await openWorkbook(bytes);
  const sheet = sheetName ? sheetOf(workbook, sheetName) : [...iterWorksheets(workbook)][0];
  if (!sheet) return fail("not_found", "The workbook has no sheets.");
  const stored = sheetChart(bytes, sheet, index);
  // A data reference with no copy of its values: nothing to draw from.
  if (!/<c:(?:num|str)Ref><c:f>[^<]+<\/c:f><\/c:(?:num|str)Ref>/.test(stored.chart)) return stored;
  // Saved without the values it plots (by an older version of this app, or
  // another writer): drawn from the cells as they are, the file untouched.
  if (needsCalculation(workbook)) recalculate(workbook);
  return sheetChart(await workbookBytes(workbook), sheet, index);
}
export type SpreadsheetInspection = Awaited<ReturnType<typeof inspectSpreadsheet>>;
export type SpreadsheetEdit = Awaited<ReturnType<typeof editSpreadsheet>>;
