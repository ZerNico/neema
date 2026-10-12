import { memo, type ReactNode } from "react";
import { columnLetters } from "@chat/sheet/a1";
import type { SheetLocale } from "@chat/sheet/locales";
import type { Sheet } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import type { CellLook } from "@chat/sheet/model/conditional";
import { key, type mergeIndex } from "./grid-navigation.ts";
import type { AxisLayout } from "./layout.ts";
import { BAND_ROWS, CellBand, RowHeaderBand } from "./grid-bands.tsx";

/** The immutable inputs shared by every cell band in a pane. */
export interface PaneDrawing {
  readonly gridId: string;
  readonly sheet: string;
  readonly cells: Sheet["cells"];
  readonly values: SheetValues;
  readonly locale: SheetLocale;
  readonly looks: ReadonlyMap<string, CellLook>;
  readonly rows: AxisLayout;
  readonly cols: AxisLayout;
  readonly merges: ReturnType<typeof mergeIndex>;
  readonly zoom: number;
  readonly frozenCols: number;
  readonly occupied: (row: number) => readonly number[];
}
export interface IndexRange {
  first: number;
  last: number;
}

export function bandRange(range: IndexRange, rows: AxisLayout): IndexRange {
  return range.last < range.first
    ? range
    : {
        first: Math.floor(range.first / BAND_ROWS) * BAND_ROWS,
        last: Math.min(
          rows.ids.length - 1,
          Math.ceil((range.last + 1) / BAND_ROWS) * BAND_ROWS - 1,
        ),
      };
}

/** Ownership lives here, outside memo bands, including an active cell beyond the drawn window. */
export const PaneCells = memo(function PaneCells({
  drawing,
  first,
  last,
  colFirst,
  colLast,
  main,
  activeRow,
  activeCol,
}: {
  drawing: PaneDrawing;
  first: number;
  last: number;
  colFirst: number;
  colLast: number;
  main: boolean;
  activeRow: number;
  activeCol: number;
}) {
  const { rows, cols, merges } = drawing;
  const bands: ReactNode[] = [];
  const firstVisible = rows.indexAt(rows.starts[first] ?? 0);
  const span = merges.spans.get(key(activeRow, activeCol));
  const activeOwner =
    span &&
    span.right >= colFirst &&
    span.left <= colLast &&
    span.bottom >= first &&
    span.top <= last
      ? Math.max(firstVisible, rows.indexAt(rows.starts[span.top]!))
      : activeRow;
  let activeDrawn = false;
  for (let start = first; start <= last;) {
    const end = Math.min(last, (Math.floor(start / BAND_ROWS) + 1) * BAND_ROWS - 1);
    if (rows.starts[end + 1]! > rows.starts[start]!) {
      const active = main && activeOwner >= start && activeOwner <= end;
      activeDrawn ||= active;
      const takesMerges =
        firstVisible >= start &&
        firstVisible <= end &&
        (merges.byRow.get(firstVisible) ?? []).some(
          (merge) =>
            rows.indexAt(rows.starts[merge.top]!) < start &&
            merge.right >= colFirst &&
            merge.left <= colLast,
        );
      bands.push(
        <CellBand
          key={Math.floor(start / BAND_ROWS)}
          drawing={drawing}
          first={start}
          last={end}
          colFirst={colFirst}
          colLast={colLast}
          main={main}
          activeRow={active ? activeRow : -1}
          activeCol={active ? activeCol : -1}
          mergeRow={takesMerges ? firstVisible : -1}
        />,
      );
    }
    start = end + 1;
  }
  if (
    main &&
    !activeDrawn &&
    activeRow >= 0 &&
    activeCol >= 0 &&
    rows.ids.length &&
    cols.ids.length
  )
    bands.push(
      <CellBand
        key="active"
        drawing={drawing}
        first={0}
        last={-1}
        colFirst={0}
        colLast={-1}
        main
        activeRow={activeRow}
        activeCol={activeCol}
        mergeRow={-1}
      />,
    );
  return bands;
});

export function rowHeaderBands(
  rows: AxisLayout,
  range: IndexRange,
  box: { top: number; bottom: number } | null,
  gutter: number,
  offset: number,
  resizable: boolean,
) {
  const bands: ReactNode[] = [];
  for (let start = range.first; start <= range.last;) {
    const end = Math.min(range.last, (Math.floor(start / BAND_ROWS) + 1) * BAND_ROWS - 1);
    if (rows.starts[end + 1]! > rows.starts[start]!) {
      const selected = box && box.bottom >= start && box.top <= end;
      bands.push(
        <RowHeaderBand
          key={Math.floor(start / BAND_ROWS)}
          rows={rows}
          first={start}
          last={end}
          selectedFirst={selected ? Math.max(start, box.top) : -1}
          selectedLast={selected ? Math.min(end, box.bottom) : -1}
          gutter={gutter}
          offset={offset}
          resizable={resizable}
        />,
      );
    }
    start = end + 1;
  }
  return bands;
}

/** Kept outside bands so a menu anchor survives changes to the band owning its row. */
export function FilterButtons({
  rows,
  cols,
  rowIndex,
  colIndex,
  rowRange,
  colRange,
  filterButtons,
  onFilterButton,
}: {
  rows: AxisLayout;
  cols: AxisLayout;
  rowIndex: ReadonlyMap<string, number>;
  colIndex: ReadonlyMap<string, number>;
  rowRange: IndexRange;
  colRange: IndexRange;
  filterButtons: {
    readonly row: string;
    readonly cols: readonly string[];
    readonly active: ReadonlySet<string>;
  } | null;
  onFilterButton: ((col: string, button: HTMLElement) => void) | undefined;
}) {
  if (!filterButtons) return null;
  const row = rowIndex.get(filterButtons.row);
  if (row === undefined || row < rowRange.first || row > rowRange.last || !rows.size(row))
    return null;
  return filterButtons.cols.map((c) => {
    const col = colIndex.get(c);
    if (col === undefined || col < colRange.first || col > colRange.last || !cols.size(col))
      return null;
    const active = filterButtons.active.has(c);
    return (
      <button
        key={c}
        type="button"
        aria-label={`Filter ${columnLetters(col + 1)}`}
        aria-pressed={active}
        tabIndex={-1}
        className={`border-border absolute z-[3] flex size-4 items-center justify-center rounded-sm border ${active ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}
        style={{
          top: rows.starts[row]! + (rows.size(row) - 16) / 2,
          left: cols.starts[col + 1]! - 18,
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => onFilterButton?.(c, event.currentTarget)}
      >
        <svg aria-hidden viewBox="0 0 10 10" className="size-2.5" fill="currentColor">
          {active ? <path d="M1 2h8L6 5.5V9L4 8V5.5z" /> : <path d="M2 3.5h6L5 7z" />}
        </svg>
      </button>
    );
  });
}
