/**
 * A live sheet document. Rows, columns and sheets are order lists of stable
 * IDs; deleting one marks it dead and keeps its place, so a reference, an
 * insert or a comment anchored to it still knows where it was. Cells are
 * keyed by row and column ID, never by position, and a formula holds its
 * references the same way. Calculated values are never stored.
 */

export interface AxisEntry {
  readonly id: string;
  readonly dead?: true;
}
export type Axis = "rows" | "columns";

/** A value someone wrote; formulas' results are calculated, never stored. */
export type CellValue = string | number | boolean;

/** One corner of a reference: a row and a column by ID, each relative or absolute. */
export interface RefCorner {
  /** Null for whole columns (`C:C`). */
  readonly row: string | null;
  /** Null for whole rows (`2:4`). */
  readonly col: string | null;
  readonly rowAbs: boolean;
  readonly colAbs: boolean;
}
/** A reference held by IDs: it follows its cells through inserts, deletes and sorts. */
export interface IdRef {
  readonly k: "ref";
  /** Null for the formula's own sheet. */
  readonly sheet: string | null;
  readonly from: RefCorner;
  readonly to: RefCorner | null;
}
/** `First:Last!A1`: positional within each sheet, as Excel's 3-D references are. */
export interface SpanRef {
  readonly k: "span";
  readonly first: string;
  readonly last: string;
  /** The reference as written, without its sheets: "A1" or "B2:C9". */
  readonly area: string;
}
/** A formula as text pieces and references; the text never names a position. */
export interface Formula {
  readonly parts: readonly (string | IdRef | SpanRef)[];
}

export interface Cell {
  readonly v?: CellValue;
  readonly f?: Formula;
  /** A legacy (CSE) array formula from an import, with the range it was entered over. */
  readonly array?: { readonly rows: number; readonly cols: number };
  /** A canonical style key; each replica interns its own table. */
  readonly s?: string;
  /** The revision that last wrote the content; a clear counts as a write. */
  readonly w: number;
  /** The revision that last wrote the format. */
  readonly wf?: number;
}

export interface Box {
  readonly r1: string;
  readonly r2: string;
  readonly c1: string;
  readonly c2: string;
}

export interface AxisProps {
  readonly size?: number;
  readonly hidden?: true;
  /** A style key for the whole row or column. */
  readonly s?: string;
}

export interface Sheet {
  readonly name: string;
  readonly rows: readonly AxisEntry[];
  readonly cols: readonly AxisEntry[];
  /** rowId → colId → cell. Absent rows and cells are empty. */
  readonly cells: Readonly<Record<string, Readonly<Record<string, Cell>>>>;
  readonly rowProps: Readonly<Record<string, AxisProps>>;
  readonly colProps: Readonly<Record<string, AxisProps>>;
  readonly merges: readonly Box[];
  /** Rows and columns frozen up to and including these IDs. */
  readonly freeze: { readonly row: string | null; readonly col: string | null };
  /** Its AutoFilter, if it has one. */
  readonly filter?: SheetFilter;
}

export type { Chart, ChartSeries } from "./chart.ts";
import type { Chart } from "./chart.ts";
import type { SheetFilter } from "./filter.ts";

/** How a document reads and shows: what people type and see follows its locale; NOW its time zone. */
export interface SheetSettings {
  /** A locale id from `SHEET_LOCALES`, such as "de-DE". */
  readonly locale: string;
  /** An IANA time zone, such as "Europe/Berlin". */
  readonly timeZone: string;
}

export interface SheetDoc {
  readonly settings: SheetSettings;
  readonly sheets: readonly AxisEntry[];
  readonly sheet: Readonly<Record<string, Sheet>>;
  /** Defined names by lower-case name: the name as written and its formula. */
  readonly names: Readonly<Record<string, { readonly name: string; readonly f: Formula }>>;
  readonly charts: Readonly<Record<string, Chart>>;
  /** Comment threads' cells, by thread ID: several threads may share a cell. */
  readonly anchors: Readonly<Record<string, CellAnchor>>;
}

/** Where a comment thread sits: a cell, or a range from it to `r2`/`c2`. */
export interface CellAnchor {
  readonly sh: string;
  readonly r: string;
  readonly c: string;
  readonly r2?: string;
  readonly c2?: string;
}

const live = (entries: readonly AxisEntry[]) => entries.filter((entry) => !entry.dead);

/**
 * Where each ID sits: its index among live entries (1-based, as Excel
 * counts), and its place in the full order, dead entries included.
 */
export interface Positions {
  readonly ids: readonly string[];
  /** Live position of an ID, or undefined when dead or unknown. */
  at(id: string): number | undefined;
  /** Place in the full order, dead entries included. */
  raw(id: string): number | undefined;
  /** The nearest live position at or after (`1`) or before (`-1`) an ID's place. */
  nearest(id: string, direction: 1 | -1): number | undefined;
}

const indexes = new WeakMap<readonly AxisEntry[], Positions>();
/** The positions of an order list, cached per list: lists are never changed in place. */
export function positions(entries: readonly AxisEntry[]): Positions {
  const known = indexes.get(entries);
  if (known) return known;
  const ids = live(entries).map((entry) => entry.id);
  const liveAt = new Map(ids.map((id, index) => [id, index + 1]));
  const rawAt = new Map(entries.map((entry, index) => [entry.id, index]));
  const found: Positions = {
    ids,
    at: (id) => liveAt.get(id),
    raw: (id) => rawAt.get(id),
    nearest: (id, direction) => {
      const start = rawAt.get(id);
      if (start === undefined) return undefined;
      for (let index = start; index >= 0 && index < entries.length; index += direction) {
        const entry = entries[index]!;
        if (!entry.dead) return liveAt.get(entry.id);
      }
      return undefined;
    },
  };
  indexes.set(entries, found);
  return found;
}

/** A new sheet's grid: as Google Sheets starts, and grown by inserts. */
export const NEW_SHEET = { rows: 1000, cols: 26 } as const;

/** A sheet with `rows` and `cols` IDs minted from `prefix`. */
export function emptySheet(
  name: string,
  prefix: string,
  size: { readonly rows: number; readonly cols: number } = NEW_SHEET,
): Sheet {
  return {
    name,
    rows: Array.from({ length: size.rows }, (_, index) => ({ id: `${prefix}r${index + 1}` })),
    cols: Array.from({ length: size.cols }, (_, index) => ({ id: `${prefix}c${index + 1}` })),
    cells: {},
    rowProps: {},
    colProps: {},
    merges: [],
    freeze: { row: null, col: null },
  };
}

/** A new document with one sheet. */
export function emptyDoc(
  sheetName = "Sheet1",
  settings: SheetSettings = { locale: "en-US", timeZone: "UTC" },
): SheetDoc {
  return {
    settings,
    sheets: [{ id: "s1" }],
    sheet: { s1: emptySheet(sheetName, "s1.") },
    names: {},
    charts: {},
    anchors: {},
  };
}

/** Live sheets in order. */
export const liveSheets = (doc: SheetDoc) => live(doc.sheets).map((entry) => entry.id);

/** A sheet by name, case-insensitively, as formulas name them. */
export const sheetNamed = (doc: SheetDoc, name: string) =>
  liveSheets(doc).find((id) => doc.sheet[id]!.name.toLowerCase() === name.toLowerCase());
