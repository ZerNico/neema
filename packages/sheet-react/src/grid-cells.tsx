import { memo, type ReactNode } from "react";
import type { SheetLocale } from "@chat/sheet/locales";
import type { Scalar } from "@chat/sheet/engine/values";
import type { GridSheet } from "./grid-model.ts";
import type { CellLook } from "./looks.ts";
import { key, type mergeIndex } from "./grid-navigation.ts";
import type { AxisLayout } from "./layout.ts";
import { BAND_ROWS, CellBand, RowHeaderBand } from "./grid-bands.tsx";

/** The immutable inputs shared by every cell band in a pane. */
export interface PaneDrawing {
  readonly gridId: string;
  readonly cells: GridSheet["cells"];
  readonly value: (r: string, c: string) => Scalar;
  readonly locale: SheetLocale;
  readonly looks: ReadonlyMap<string, CellLook>;
  readonly rows: AxisLayout;
  readonly cols: AxisLayout;
  readonly merges: ReturnType<typeof mergeIndex>;
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
        merges
          .inRow(firstVisible)
          .some(
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
  offset: number,
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
          offset={offset}
        />,
      );
    }
    start = end + 1;
  }
  return bands;
}
