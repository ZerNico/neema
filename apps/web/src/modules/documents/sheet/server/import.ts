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
  type CellAnchor,
  type Sheet,
  type SheetDoc,
  type SheetSettings,
} from "@chat/sheet/model";
import { parseTyped } from "@chat/sheet/value-parse";
import type { Chart } from "@chat/sheet/model/chart";
import type { FileFilter, LiveSheetImport } from "~/modules/spreadsheets/server/adapter.ts";
import type { FileNote } from "~/modules/spreadsheets/server/file-notes.ts";
import type { FileGroup } from "~/modules/spreadsheets/server/file-outline.ts";
import { toEngineFormula } from "~/modules/spreadsheets/server/formulas.ts";
import type { FilterRule, SheetFilter } from "@chat/sheet/model/filter";
import type { Validation } from "@chat/sheet/model/validation";
import { chartOfFile } from "./chart-files.ts";
import { IMAGE_LIMITS, type SheetImage } from "@chat/sheet/model/image";

/** A file's note, as the comment thread it becomes on the cells it was on. */
export interface ImportedNote {
  readonly cell: CellAnchor;
  readonly entries: FileNote["entries"];
}
export type Imported =
  | { ok: true; doc: SheetDoc; dropped: string[]; notes: ImportedNote[] }
  | { ok: false; reason: string };

/** Rows and columns across a workbook's sheets that an import builds at most. */
const IMPORT_ENTRIES = 2 * LIVE_LIMITS.rows;

/** A file's groups by position as a live sheet keeps them, by IDs; ones past the grid are left out. */
const groupsOf = (groups: readonly FileGroup[], ids: readonly string[]) =>
  groups.flatMap((group) =>
    ids[group.from - 1] && ids[group.to - 1]
      ? [
          {
            from: ids[group.from - 1]!,
            to: ids[group.to - 1]!,
            ...(group.collapsed ? { collapsed: true as const } : {}),
          },
        ]
      : [],
  );

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
/** Sizes and hidden flags by ID, from a file's positions. */
const sized = (
  entries: ReadonlyArray<readonly [number, number]>,
  hidden: readonly number[] | undefined,
  axis: readonly string[],
) => {
  const props: Record<string, { size?: number; hidden?: true }> = {};
  for (const [at, size] of entries) if (axis[at - 1]) props[axis[at - 1]!] = { size };
  for (const at of hidden ?? [])
    if (axis[at - 1]) props[axis[at - 1]!] = { ...props[axis[at - 1]!], hidden: true };
  return props;
};

/** A file's AutoFilter by IDs; a column keeping its listed values, and empty cells when it says so. */
function filterOf(
  file: FileFilter,
  rows: readonly string[],
  cols: readonly string[],
): SheetFilter | null {
  const box = parseRange(file.ref);
  if (!box || !rows[box.bottom - 1] || !cols[box.right - 1]) return null;
  const rules: Record<string, FilterRule> = {};
  for (const column of file.columns) {
    const id = cols[box.left - 1 + column.col];
    if (!id || box.left + column.col > box.right) continue;
    rules[id] = { values: [...column.values, ...(column.blank ? [""] : [])] };
  }
  return {
    box: {
      r1: rows[box.top - 1]!,
      r2: rows[box.bottom - 1]!,
      c1: cols[box.left - 1]!,
      c2: cols[box.right - 1]!,
    },
    rules,
  };
}

/**
 * A live sheet from a workbook read by position. Every sheet's grid exists
 * before any formula is read, so references across sheets find their cells;
 * one reaching past a grid grows it. Over the live limits it is refused.
 */
export function sheetFromWorkbook(read: LiveSheetImport, settings: SheetSettings): Imported {
  if (!read.sheets.length) return { ok: false, reason: "the workbook has no sheets" };
  if (read.sheets.length > LIVE_LIMITS.sheets)
    return { ok: false, reason: `more than ${LIVE_LIMITS.sheets} sheets` };
  // Sized before any grid is built, so a file naming a far cell costs nothing to refuse.
  if (read.sheets.some((each) => each.rows > LIVE_LIMITS.rows || each.cols > LIVE_LIMITS.cols))
    return { ok: false, reason: "a sheet larger than a live sheet holds" };
  const entries = read.sheets.reduce(
    (total, each) =>
      total + Math.max(NEW_SHEET.rows, each.rows) + Math.max(NEW_SHEET.cols, each.cols),
    0,
  );
  if (entries > IMPORT_ENTRIES)
    return { ok: false, reason: "more rows across its sheets than a live sheet holds" };
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
  /** A formula's stored form, the grids grown for what it reaches. */
  const formulaOf = (stored: string, sheet: string) => {
    // As people read it: without the namespaces a file stores newer functions under.
    const text = toEngineFormula(stored).slice(1);
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
  /** A list's cells, as `Sheet!$A$1:$A$9` text, by IDs on the imported sheets. */
  const sourceOf = (text: string, home: string) => {
    const bang = text.lastIndexOf("!");
    const name =
      bang === -1
        ? null
        : text
            .slice(0, bang)
            .replace(/^'(.*)'$/, "$1")
            .replaceAll("''", "'");
    const on = name === null ? home : ids[read.sheets.findIndex((each) => each.name === name)];
    const box = parseRange((bang === -1 ? text : text.slice(bang + 1)).replaceAll("$", ""));
    if (!on || !box) return null;
    const [r, c] = [positions(doc.sheet[on]!.rows).ids, positions(doc.sheet[on]!.cols).ids];
    if (!r[box.bottom - 1] || !c[box.right - 1]) return null;
    return {
      sh: on,
      box: {
        r1: r[box.top - 1]!,
        r2: r[box.bottom - 1]!,
        c1: c[box.left - 1]!,
        c2: c[box.right - 1]!,
      },
    };
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
          ...(each.color ? { color: each.color } : {}),
          ...(each.outline
            ? {
                outline: {
                  ...(each.outline.rows?.length ? { rows: groupsOf(each.outline.rows, rows) } : {}),
                  ...(each.outline.cols?.length ? { cols: groupsOf(each.outline.cols, cols) } : {}),
                },
              }
            : {}),
          colProps: sized(each.widths, each.hiddenCols, cols),
          rowProps: sized(each.heights, each.hiddenRows, rows),
          ...(each.validations?.length
            ? {
                validations: each.validations.flatMap((validation, place) => {
                  const box = parseRange(validation.ref);
                  if (!box || !rows[box.bottom - 1] || !cols[box.right - 1]) return [];
                  const { rule } = validation;
                  let kept: Validation["rule"];
                  if (rule.kind === "list" && "source" in rule) {
                    const source = sourceOf(rule.source, id);
                    if (!source) return [];
                    kept = { kind: "list", source };
                  } else kept = rule.kind === "list" ? { kind: "list", values: rule.values } : rule;
                  return [
                    {
                      id: `dv${place + 1}`,
                      box: {
                        r1: rows[box.top - 1]!,
                        r2: rows[box.bottom - 1]!,
                        c1: cols[box.left - 1]!,
                        c2: cols[box.right - 1]!,
                      },
                      rule: kept,
                      onError: validation.onError,
                      allowBlank: validation.allowBlank,
                      ...(validation.message ? { message: validation.message } : {}),
                    },
                  ];
                }),
              }
            : {}),
          ...(each.conditional?.length
            ? {
                conditional: each.conditional.flatMap((format, place) => {
                  const box = parseRange(format.ref);
                  if (!box || !rows[box.bottom - 1] || !cols[box.right - 1]) return [];
                  return [
                    {
                      id: `cf${place + 1}`,
                      box: {
                        r1: rows[box.top - 1]!,
                        r2: rows[box.bottom - 1]!,
                        c1: cols[box.left - 1]!,
                        c2: cols[box.right - 1]!,
                      },
                      rule: format.rule,
                    },
                  ];
                }),
              }
            : {}),
          ...(each.filter && filterOf(each.filter, rows, cols)
            ? { filter: filterOf(each.filter, rows, cols)! }
            : {}),
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
  const images: Record<string, SheetImage> = {};
  for (const [index, file] of read.images.slice(0, IMAGE_LIMITS.images).entries()) {
    const sheet = ids[read.sheets.findIndex((each) => each.name === file.sheet)];
    const corner = parseCell(file.at);
    if (!sheet || !corner) continue;
    const [r, c] = [
      positions(doc.sheet[sheet]!.rows).ids[corner.row - 1],
      positions(doc.sheet[sheet]!.cols).ids[corner.column - 1],
    ];
    if (!r || !c) continue;
    images[`picture${index + 1}`] = {
      sheet,
      at: { r, c },
      ...(file.offset ? { offset: file.offset } : {}),
      size: { width: file.width, height: file.height },
      src: file.src,
      ...(file.alt ? { alt: file.alt } : {}),
    };
  }
  doc = { ...doc, charts, ...(Object.keys(images).length ? { images } : {}) };
  const over = overLimits(doc);
  if (over) return { ok: false, reason: over };
  const notes = read.sheets.flatMap((each, index) =>
    (each.notes ?? []).flatMap((note): ImportedNote[] => {
      const sh = ids[index]!;
      const box = parseRange(note.ref);
      const [rows, cols] = [positions(doc.sheet[sh]!.rows).ids, positions(doc.sheet[sh]!.cols).ids];
      if (!box || !rows[box.bottom - 1] || !cols[box.right - 1]) return [];
      const range = box.top !== box.bottom || box.left !== box.right;
      return [
        {
          cell: {
            sh,
            r: rows[box.top - 1]!,
            c: cols[box.left - 1]!,
            ...(range ? { r2: rows[box.bottom - 1]!, c2: cols[box.right - 1]! } : {}),
          },
          entries: note.entries,
        },
      ];
    }),
  );
  return { ok: true, doc, dropped: [...read.dropped], notes };
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
    images: [],
    dropped: [],
  };
}

export const sheetFromCsv = (text: string, name: string, settings: SheetSettings) =>
  sheetFromWorkbook(readCsv(text, name), settings);
