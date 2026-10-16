import { memo } from "react";
import type { ReactNode } from "react";
import { cellStyle } from "@chat/sheet/style";
import { GridCell } from "./grid-cell.tsx";
import { key } from "./grid-navigation.ts";
import { precedingColumn } from "./grid-spill.ts";
import { HEADER_COLUMN_PX, textWidth, type AxisLayout } from "./layout.ts";
import type { PaneDrawing } from "./grid-cells.tsx";

export const BAND_ROWS = 16;

/** Stable sheet data and band-local numbers, never the moving viewport or selection object. */
export interface CellBandProps {
  drawing: PaneDrawing;
  first: number;
  last: number;
  colFirst: number;
  colLast: number;
  main: boolean;
  activeRow: number;
  activeCol: number;
  /** A preceding merge transfers here only while its natural band is not drawn. */
  mergeRow: number;
}

export function CellBandBody({
  drawing,
  first,
  last,
  colFirst,
  colLast,
  main,
  activeRow,
  activeCol,
  mergeRow,
}: CellBandProps) {
  const {
    gridId,
    cells: sheetCells,
    value,
    locale,
    looks,
    rows,
    cols,
    merges,
    frozenCols,
  } = drawing;
  const cells: ReactNode[] = [];
  const drawn = new Set<string>();
  const draw = (row: number, col: number, overflowTo = col) => {
    if (drawn.has(key(row, col))) return;
    drawn.add(key(row, col));
    const span = merges.spans.get(key(row, col));
    const r = rows.ids[row]!;
    const c = cols.ids[col]!;
    const active = main && row === activeRow && col === activeCol;
    const spills = !span && overflowTo > col;
    if (spills)
      cells.push(
        <div
          key={`${key(row, col)}-spill`}
          aria-hidden
          className="border-border bg-background absolute z-[1] border-b"
          style={{
            top: rows.starts[row],
            left: cols.starts[col + 1],
            height: rows.size(row),
            width: cols.starts[overflowTo + 1]! - cols.starts[col + 1]!,
          }}
        />,
      );
    cells.push(
      <GridCell
        key={key(row, col)}
        id={active ? `${gridId}-active` : undefined}
        main={main}
        active={active}
        row={row}
        col={col}
        top={rows.starts[row]!}
        left={cols.starts[col]!}
        height={rows.starts[(span?.bottom ?? row) + 1]! - rows.starts[row]!}
        width={cols.starts[(span?.right ?? col) + 1]! - cols.starts[col]!}
        value={value(r, c)}
        styleKey={sheetCells[r]?.[c]?.s}
        look={looks.get(`${r}|${c}`)}
        locale={locale}
        spills={spills}
        merged={!!span}
      />,
    );
  };
  const spillEnd = (row: number, col: number) => {
    const r = rows.ids[row]!;
    const held = value(r, cols.ids[col]!);
    const style = cellStyle(sheetCells[r]?.[cols.ids[col]!]?.s);
    if (
      typeof held !== "string" ||
      style.wrap ||
      (style.horizontal ?? "left") !== "left" ||
      merges.spans.has(key(row, col))
    )
      return col;
    const needed = textWidth(held, style.fontSize ? (style.fontSize * 4) / 3 : 14, style.bold) + 8;
    const limit = col < frozenCols ? Math.min(colLast, frozenCols - 1) : colLast;
    let end = col;
    while (end < limit && cols.starts[end + 1]! - cols.starts[col]! < needed) {
      const next = end + 1;
      if (merges.covered(row, next) || merges.spans.has(key(row, next))) break;
      if (cols.size(next) && value(r, cols.ids[next]!) !== null) break;
      end = next;
    }
    return end;
  };
  for (let row = first; row <= last; row++) {
    if (!rows.size(row)) continue;
    let start = colFirst;
    // Search occupied columns, not the empty distance back to the frozen boundary.
    const boundary = colFirst >= frozenCols ? frozenCols : 0;
    const origin = colFirst > boundary ? precedingColumn(drawing.occupied(row), colFirst) : -1;
    const blocked = merges.inRow(row).some((span) => span.right >= origin && span.left < colFirst);
    if (origin >= boundary && !blocked) {
      const end = spillEnd(row, origin);
      if (end >= colFirst) {
        draw(row, origin, end);
        start = end + 1;
      }
    }
    for (let col = start; col <= colLast; col++) {
      if (!cols.size(col) || merges.covered(row, col) || merges.spans.has(key(row, col))) continue;
      const end = spillEnd(row, col);
      draw(row, col, end);
      col = end;
    }
    for (const span of merges.inRow(row)) {
      const owner = rows.indexAt(rows.starts[span.top]!);
      if (owner >= first && owner <= last && span.right >= colFirst && span.left <= colLast)
        draw(span.top, span.left);
    }
  }
  if (mergeRow >= 0)
    for (const span of merges.inRow(mergeRow)) {
      if (
        rows.indexAt(rows.starts[span.top]!) < first &&
        span.right >= colFirst &&
        span.left <= colLast
      )
        draw(span.top, span.left);
    }
  // An active empty cell under a spill, or a covered coordinate, still has one accessible node.
  if (main && activeRow >= 0) draw(activeRow, activeCol);
  return cells;
}
export const CellBand = memo(CellBandBody);

export interface RowHeaderBandProps {
  rows: AxisLayout;
  first: number;
  last: number;
  selectedFirst: number;
  selectedLast: number;
  offset: number;
}
export function RowHeaderBandBody({
  rows,
  first,
  last,
  selectedFirst,
  selectedLast,
  offset,
}: RowHeaderBandProps) {
  const headers: ReactNode[] = [];
  for (let row = first; row <= last; row++) {
    if (!rows.size(row)) continue;
    const selected = row >= selectedFirst && row <= selectedLast;
    headers.push(
      <div
        key={row}
        role="rowheader"
        data-sheet-axis="rows"
        data-sheet-index={row}
        className={`border-border text-muted-foreground absolute flex cursor-default items-center justify-center border-r border-b text-xs ${selected ? "bg-accent text-accent-foreground" : "bg-muted"}`}
        style={{
          top: offset + rows.starts[row]!,
          left: 0,
          height: rows.size(row),
          width: HEADER_COLUMN_PX,
        }}
      >
        {row + 1}
      </div>,
    );
  }
  return headers;
}
export const RowHeaderBand = memo(RowHeaderBandBody);
