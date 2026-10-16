import type { BorderLine, CellStyle } from "@chat/sheet/style";
import { XError } from "@chat/sheet/engine/values";
import { isFormulaValue, type Cell } from "@office-kit/xlsx/cell";
import { listChartsOnSheet, listImagesOnSheet } from "@office-kit/xlsx/drawing";
import {
  getCellAlignment,
  getCellBorder,
  getCellFill,
  getCellFont,
  classifyDateFormat,
  getCellNumberFormat,
  type Color,
} from "@office-kit/xlsx/styles";
import { getSheetState, iterWorksheets, type Workbook } from "@office-kit/xlsx/workbook";
import {
  getColumnDimension,
  getFreezePanes,
  getMergedCells,
  getRowDimension,
  iterCells,
} from "@office-kit/xlsx/worksheet";
import { boxRef, parseRange } from "@chat/sheet/a1";
import { SpreadsheetError } from "../errors.ts";
import { SPREADSHEET_LIMITS } from "../limits.ts";
import type { PreviewCell, PreviewValue, SpreadsheetPreview } from "../preview.ts";
import {
  calculateMissing,
  openWorkbook,
  sheetOf,
  unshareFormulas,
  workbookBytes,
} from "./adapter.ts";
import { scalarOf } from "./calc.ts";
import { sheetChart, sheetCharts } from "./chart-parts.ts";
import { fileColors } from "./file-colors.ts";
import { fileHighlightStyles, readConditional } from "./file-conditional.ts";
import { readImage } from "./file-images.ts";
import { toEngineFormula } from "./formulas.ts";

const fail = (code: string, message: string): never => {
  throw new SpreadsheetError(code, message);
};

/** Fonts Excel and its readers start a workbook with; a cell in one draws in the grid's own. */
const DEFAULT_FONTS = new Set(["Calibri", "Aptos", "Aptos Narrow", "Arial"]);
/** A link a preview may open: web and mail addresses only. */
const webLink = (text: unknown) =>
  typeof text === "string" && /^(https?:\/\/|mailto:)/i.test(text) && text.length <= 2079
    ? text
    : null;

type ColorOf = (color: Color | undefined) => string | null;

/**
 * A file's edge as a line, or null for none. Excel's other dashes draw as
 * dashed and its hair line as thin; black is the default colour, kept as none.
 */
function lineOf(side: { style?: string; color?: Color } | undefined, colorOf: ColorOf) {
  const name = side?.style;
  if (!name || name === "none") return null;
  const style: BorderLine["style"] =
    name === "medium" || name === "thick" || name === "double" || name === "dotted"
      ? name
      : /dash/i.test(name)
        ? "dashed"
        : "thin";
  const color = colorOf(side.color);
  return color && color !== "#000000" ? { style, color } : { style };
}

/** A cell's look as the grid draws it. */
function styleOf(workbook: Workbook, cell: Cell, colorOf: ColorOf, link: string | undefined) {
  const style: { -readonly [K in keyof CellStyle]?: CellStyle[K] } = {};
  const font = getCellFont(workbook, cell);
  if (font.bold) style.bold = true;
  if (font.italic) style.italic = true;
  if (font.underline) style.underline = true;
  if (font.strike) style.strike = true;
  if (font.name && !DEFAULT_FONTS.has(font.name)) style.fontFamily = font.name;
  if (font.size && font.size !== 11) style.fontSize = font.size;
  const fontColor = colorOf(font.color);
  if (fontColor && fontColor !== "#000000") style.fontColor = fontColor;
  // A patterned fill draws as its foreground and a gradient as its first stop: close, never empty.
  const fill = getCellFill(workbook, cell);
  const fillColor =
    fill.kind === "gradient"
      ? colorOf(fill.stops[0]?.color)
      : fill.patternType && fill.patternType !== "none"
        ? (colorOf(fill.fgColor) ?? colorOf(fill.bgColor))
        : null;
  if (fillColor) style.fill = fillColor;
  const format = getCellNumberFormat(workbook, cell);
  if (format && format !== "General") style.numberFormat = format;
  const { horizontal, vertical, wrapText } = getCellAlignment(workbook, cell);
  if (horizontal === "left" || horizontal === "center" || horizontal === "right")
    style.horizontal = horizontal;
  if (vertical === "top" || vertical === "center" || vertical === "bottom")
    style.vertical = vertical;
  if (wrapText) style.wrap = true;
  const border = getCellBorder(workbook, cell);
  const edges = [
    ["borderTop", border.top],
    ["borderBottom", border.bottom],
    ["borderLeft", border.left],
    ["borderRight", border.right],
  ] as const;
  for (const [key, side] of edges) {
    const line = lineOf(side, colorOf);
    if (line) style[key] = line;
  }
  if (link) style.link = link;
  return style;
}

/** Days from the 1904 date system's day 0 to the 1900 system's, as Excel counts them. */
const DAYS_1904 = 1_462;

/**
 * What a cell stores, as the grid reads it. The grid's dates count from 1900,
 * so a date in a workbook on the 1904 system is moved onto that calendar.
 */
const valueOf = (workbook: Workbook, cell: Cell): PreviewValue | undefined => {
  const scalar = scalarOf(cell.value);
  if (scalar instanceof XError) return { error: scalar.code };
  if (scalar === null || scalar === "") return undefined;
  if (typeof scalar === "number" && workbook.date1904) {
    const kind = classifyDateFormat(getCellNumberFormat(workbook, cell));
    if (kind === "date" || kind === "datetime") return scalar + DAYS_1904;
  }
  return scalar;
};

/**
 * One sheet as a person sees it in Excel: stored values and formulas,
 * styles, sizes, merges, panes, hidden rows and columns, conditional
 * formats, pictures and where charts sit. Bounded by cells; past the bound
 * the rest is left out and said so.
 */
export async function previewSpreadsheet(
  bytes: Uint8Array,
  sheetName?: string,
): Promise<SpreadsheetPreview> {
  const workbook = await openWorkbook(bytes);
  unshareFormulas(workbook);
  // Results a file was saved without are calculated for showing; stored ones are kept.
  calculateMissing(workbook);
  const worksheets = [...iterWorksheets(workbook)];
  // The first sheet a person would see: hidden ones have no tab.
  const sheet = sheetName
    ? sheetOf(workbook, sheetName)
    : (worksheets.find((each) => getSheetState(workbook, each.title) === "visible") ??
      worksheets[0]);
  if (!sheet) return fail("not_found", "The workbook has no sheets.");
  const colorOf = fileColors(workbook);

  const links = new Map<string, string>();
  for (const hyperlink of sheet.hyperlinks) {
    const link = webLink(hyperlink.target);
    const box = parseRange(hyperlink.ref);
    if (!link || !box) continue;
    for (let row = box.top; row <= Math.min(box.bottom, box.top + 999); row++)
      for (let col = box.left; col <= Math.min(box.right, box.left + 99); col++)
        links.set(`${row}:${col}`, link);
  }
  const styles: CellStyle[] = [];
  const styleIndex = new Map<string, number>();
  const cells: PreviewCell[] = [];
  let [rows, cols] = [0, 0];
  let truncated = false;
  const ordered = [...iterCells(sheet)].toSorted((a, b) => a.row - b.row || a.col - b.col);
  for (const cell of ordered) {
    const value = valueOf(workbook, cell);
    const formula =
      isFormulaValue(cell.value) && cell.value.formula
        ? toEngineFormula(cell.value.formula)
        : undefined;
    const style = styleOf(workbook, cell, colorOf, links.get(`${cell.row}:${cell.col}`));
    const styled = Object.keys(style).length > 0;
    if (value === undefined && formula === undefined && !styled) continue;
    if (cells.length >= SPREADSHEET_LIMITS.previewCells && cell.row > rows) {
      truncated = true;
      break;
    }
    let index: number | undefined;
    if (styled) {
      const key = JSON.stringify(style);
      index = styleIndex.get(key);
      if (index === undefined) {
        index = styles.push(style) - 1;
        styleIndex.set(key, index);
      }
    }
    cells.push({
      row: cell.row,
      col: cell.col,
      ...(value === undefined ? {} : { value }),
      ...(formula === undefined ? {} : { formula }),
      ...(index === undefined ? {} : { style: index }),
    });
    rows = Math.max(rows, cell.row);
    cols = Math.max(cols, cell.col);
  }

  const merges = getMergedCells(sheet)
    .filter((merge) => !truncated || merge.minRow <= rows)
    .slice(0, SPREADSHEET_LIMITS.previewMerges)
    .map((merge) =>
      boxRef({ top: merge.minRow, left: merge.minCol, bottom: merge.maxRow, right: merge.maxCol }),
    );
  const widths: Array<[number, number]> = [];
  const hiddenCols: number[] = [];
  for (let col = 1; col <= Math.max(cols, 26); col++) {
    const dimension = getColumnDimension(sheet, col);
    if (dimension?.width !== undefined) widths.push([col, dimension.width]);
    if (dimension?.hidden) hiddenCols.push(col);
  }
  const heights: Array<[number, number]> = [];
  const hiddenRows: number[] = [];
  for (let row = 1; row <= rows; row++) {
    const dimension = getRowDimension(sheet, row);
    if (dimension?.height !== undefined) heights.push([row, dimension.height]);
    if (dimension?.hidden) hiddenRows.push(row);
  }
  const highlights = fileHighlightStyles(bytes);
  const conditional = sheet.conditionalFormatting
    .flatMap((format) =>
      format.rules.flatMap((rule) => {
        const read = readConditional(rule, highlights);
        return read
          ? format.sqref.ranges.map((range) => ({
              ref: boxRef({
                top: range.minRow,
                left: range.minCol,
                bottom: range.maxRow,
                right: range.maxCol,
              }),
              rule: read,
              priority: rule.priority,
            }))
          : [];
      }),
    )
    .toSorted((a, b) => a.priority - b.priority)
    .slice(0, SPREADSHEET_LIMITS.previewRules)
    .map(({ ref, rule }) => ({ ref, rule }));
  const drawn = sheetCharts(bytes, sheet);
  // Pictures in drawing order, until the preview's count or size is spent.
  const images: SpreadsheetPreview["images"][number][] = [];
  let imageChars = 0;
  for (const item of listImagesOnSheet(sheet)) {
    if (images.length >= SPREADSHEET_LIMITS.previewImages) break;
    const image = readImage(sheet, item);
    if (!image || imageChars + image.src.length > SPREADSHEET_LIMITS.previewImagesChars) continue;
    imageChars += image.src.length;
    images.push(image);
  }
  const freeze = getFreezePanes(sheet);
  return {
    sheets: worksheets.map((each) => {
      const color = colorOf(each.sheetProperties?.tabColor);
      return {
        name: each.title,
        ...(getSheetState(workbook, each.title) === "visible" ? {} : { hidden: true as const }),
        ...(color ? { color } : {}),
      };
    }),
    sheet: sheet.title,
    rows,
    cols,
    cells,
    styles,
    widths,
    heights,
    merges,
    ...(freeze ? { freeze } : {}),
    hiddenRows,
    hiddenCols,
    conditional,
    charts: drawn.charts.map((chart, index) => ({
      index,
      row: chart.place.row,
      col: chart.place.col,
      x: chart.place.x,
      y: chart.place.y,
      // Points to pixels.
      width: Math.round((chart.width * 4) / 3),
      height: Math.round((chart.height * 4) / 3),
    })),
    // The model reads charts however their XML is written, so its count is the floor.
    otherCharts: Math.max(drawn.others, listChartsOnSheet(sheet).length - drawn.charts.length),
    images,
    truncated,
  };
}

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
  // A data reference with no copy of its values, under any namespace prefix: nothing to draw from.
  const bare = /<([\w.-]+:)?(num|str)Ref>\s*<\1f>[^<]+<\/\1f>\s*<\/\1\2Ref>/.test(stored.chart);
  if (!bare) return stored;
  // Saved without the values it plots (by an older version of this app, or
  // another writer): drawn from the cells as they are, the file untouched.
  calculateMissing(workbook);
  return sheetChart(await workbookBytes(workbook), sheet, index);
}
