import { parseCell, parseRange } from "@chat/sheet/a1";
import { parseDelimited } from "@chat/sheet/delimited";
import { DE_DE, EN_US } from "@chat/sheet/locales";
import { styleKey } from "@chat/sheet/model/apply";
import { parseFormula } from "@chat/sheet/model/formula";
import { LIVE_LIMITS, overLimits } from "@chat/sheet/model/limits";
import {
  NEW_SHEET,
  emptySheet,
  positions,
  type Cell,
  type Sheet,
  type SheetDoc,
  type SheetSettings,
} from "@chat/sheet/model";
import { parseTyped } from "@chat/sheet/value-parse";
import type { Chart } from "@chat/sheet/model/chart";
import type { LiveSheetImport } from "~/modules/spreadsheets/server/adapter.ts";
import { chartOfFile } from "./chart-files.ts";

export type Imported =
  | { ok: true; doc: SheetDoc; dropped: string[] }
  | { ok: false; reason: string };

/** Appends rows or columns to a sheet being built until it has `rows` and `cols`. */
function grow(sheet: Sheet, id: string, rows: number, cols: number): Sheet {
  const have = { rows: sheet.rows.length, cols: sheet.cols.length };
  return {
    ...sheet,
    rows: [
      ...sheet.rows,
      ...Array.from({ length: Math.max(0, rows - have.rows) }, (_, n) => ({
        id: `${id}.r${have.rows + n + 1}`,
      })),
    ],
    cols: [
      ...sheet.cols,
      ...Array.from({ length: Math.max(0, cols - have.cols) }, (_, n) => ({
        id: `${id}.c${have.cols + n + 1}`,
      })),
    ],
  };
}

/** Sizes by position as props by ID. */
const sized = (entries: ReadonlyArray<readonly [number, number]>, axis: readonly string[]) =>
  Object.fromEntries(
    entries.flatMap(([at, size]) => (axis[at - 1] ? [[axis[at - 1]!, { size }]] : [])),
  );

/**
 * A live sheet from a workbook read by position. Every sheet's grid exists
 * before any formula is read, so references across sheets find their cells;
 * one reaching past a grid grows it. Over the live limits it is refused.
 */
export function sheetFromWorkbook(read: LiveSheetImport, settings: SheetSettings): Imported {
  if (!read.sheets.length) return { ok: false, reason: "the workbook has no sheets" };
  if (read.sheets.length > LIVE_LIMITS.sheets)
    return { ok: false, reason: `more than ${LIVE_LIMITS.sheets} sheets` };
  const ids = read.sheets.map((_, index) => `s${index + 1}`);
  let doc: SheetDoc = {
    settings,
    sheets: ids.map((id) => ({ id })),
    sheet: Object.fromEntries(
      read.sheets.map((each, index) => [
        ids[index]!,
        emptySheet(each.name, `${ids[index]}.`, {
          rows: Math.max(NEW_SHEET.rows, each.rows),
          cols: Math.max(NEW_SHEET.cols, each.cols),
        }),
      ]),
    ),
    names: {},
    charts: {},
    anchors: {},
  };
  if (read.sheets.some((each) => each.rows > LIVE_LIMITS.rows || each.cols > LIVE_LIMITS.cols))
    return { ok: false, reason: "a sheet larger than a live sheet holds" };
  /** A formula's stored form, the grids grown for what it reaches. */
  const formulaOf = (text: string, sheet: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const parsed = parseFormula(text, { doc, sheet });
      if ("formula" in parsed) return parsed.formula;
      for (const each of parsed.grow) {
        if (each.rows > LIVE_LIMITS.rows || each.cols > LIVE_LIMITS.cols) return null;
        const current = doc.sheet[each.sheet]!;
        doc = {
          ...doc,
          sheet: {
            ...doc.sheet,
            [each.sheet]: grow(current, each.sheet, each.rows, each.cols),
          },
        };
      }
    }
    return null;
  };
  // Formulas first, since one may grow a grid the cells are then written into.
  const formulas = read.sheets.map((each, index) =>
    each.cells.map((cell) =>
      cell.formula === undefined ? undefined : formulaOf(cell.formula, ids[index]!),
    ),
  );
  for (const [index, each] of read.sheets.entries()) {
    const id = ids[index]!;
    const sheet = doc.sheet[id]!;
    const rows = positions(sheet.rows).ids;
    const cols = positions(sheet.cols).ids;
    const cells: Record<string, Record<string, Cell>> = {};
    for (const [at, cell] of each.cells.entries()) {
      const r = rows[cell.row - 1]!;
      const c = cols[cell.column - 1]!;
      const f = formulas[index]![at];
      const s = cell.style ? styleKey(cell.style) : undefined;
      // A formula that cannot be held keeps its text, as the file showed it.
      const content: Partial<Cell> =
        cell.formula !== undefined
          ? f
            ? { f, ...(cell.array ? { array: cell.array } : {}) }
            : { v: `=${cell.formula}` }
          : cell.value !== undefined
            ? { v: cell.value }
            : {};
      (cells[r] ??= {})[c] = { ...content, w: 0, ...(s ? { s } : {}) };
    }
    const merges = each.merges.flatMap((text) => {
      const box = parseRange(text);
      return box && rows[box.bottom - 1] && cols[box.right - 1]
        ? [
            {
              r1: rows[box.top - 1]!,
              r2: rows[box.bottom - 1]!,
              c1: cols[box.left - 1]!,
              c2: cols[box.right - 1]!,
            },
          ]
        : [];
    });
    const frozen = each.freeze ? parseCell(each.freeze) : null;
    doc = {
      ...doc,
      sheet: {
        ...doc.sheet,
        [id]: {
          ...sheet,
          cells,
          colProps: sized(each.widths, cols),
          rowProps: sized(each.heights, rows),
          merges,
          freeze: {
            row: frozen && frozen.row > 1 ? (rows[frozen.row - 2] ?? null) : null,
            col: frozen && frozen.column > 1 ? (cols[frozen.column - 2] ?? null) : null,
          },
        },
      },
    };
  }
  const names: Record<string, SheetDoc["names"][string]> = {};
  for (const name of read.names.slice(0, LIVE_LIMITS.names)) {
    const f = formulaOf(name.value, ids[0]!);
    if (f) names[name.name.toLowerCase()] = { name: name.name, f };
  }
  doc = { ...doc, names };
  const charts: Record<string, Chart> = {};
  for (const [index, file] of read.charts.entries()) {
    const chart = chartOfFile(doc, file);
    if (chart) charts[`chart${index + 1}`] = chart;
  }
  doc = { ...doc, charts };
  const over = overLimits(doc);
  if (over) return { ok: false, reason: over };
  return { ok: true, doc, dropped: [...read.dropped] };
}

/**
 * A live sheet from CSV text. More semicolons than commas on the first line
 * means European CSV, with decimal commas. Each field is read as if typed, a
 * leading "=" making a formula, as Excel opens one.
 */
export function readCsv(text: string, name: string): LiveSheetImport {
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? undefined : text.search(/\r?\n/));
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const european = semicolons > commas;
  const rows = parseDelimited(text.replace(/^﻿/, ""), european ? ";" : ",");
  const locale = european ? DE_DE : EN_US;
  const width = Math.max(...rows.map((row) => row.length));
  return {
    sheets: [
      {
        name: name.slice(0, 31) || "Sheet1",
        rows: rows.length,
        cols: width,
        cells: rows.flatMap((row, y) =>
          row.flatMap((raw, x): Array<LiveSheetImport["sheets"][number]["cells"][number]> => {
            if (raw.startsWith("=") && raw.length > 1)
              return [{ row: y + 1, column: x + 1, formula: raw.slice(1) }];
            const typed = parseTyped(raw, locale);
            if (typed.kind === "empty") return [];
            return [
              {
                row: y + 1,
                column: x + 1,
                value: typed.value,
                ...(typed.kind === "number" && typed.format
                  ? { style: { numberFormat: typed.format } }
                  : {}),
              },
            ];
          }),
        ),
        merges: [],
        widths: [],
        heights: [],
      },
    ],
    names: [],
    charts: [],
    dropped: [],
  };
}

export const sheetFromCsv = (text: string, name: string, settings: SheetSettings) =>
  sheetFromWorkbook(readCsv(text, name), settings);
