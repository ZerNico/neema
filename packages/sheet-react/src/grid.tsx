import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { columnLetters } from "@chat/sheet/a1";
import type { SheetLocale } from "@chat/sheet/locales";
import type { SheetValues } from "@chat/sheet/model/calc";
import type { SheetDoc } from "@chat/sheet/model";
import { cellCss, cellDisplay, cellStyle } from "./display.ts";
import {
  HEADER_COLUMN_PX,
  HEADER_ROW_PX,
  axisLayout,
  columnPx,
  rowPx,
  visibleRange,
  type AxisLayout,
} from "./layout.ts";

export interface CellRef {
  readonly r: string;
  readonly c: string;
}
/** A rectangle from where it started to where it ends now, by IDs, so edits never move it. */
export interface SheetSelection {
  readonly anchor: CellRef;
  readonly head: CellRef;
}

export interface SheetGridProps {
  readonly doc: SheetDoc;
  /** The sheet shown, by ID. */
  readonly sheet: string;
  readonly values: SheetValues;
  readonly locale: SheetLocale;
  readonly selection: SheetSelection | null;
  readonly onSelectionChange: (selection: SheetSelection) => void;
  /** The grid's accessible name. */
  readonly label: string;
}

/** jsdom and a hidden panel measure nothing; a typical panel's size stands in. */
const FALLBACK = { width: 960, height: 640 };
const key = (row: number, col: number) => `${row}:${col}`;

/** Row and column indexes of every merged range, and the cells each hides. */
function mergeIndex(doc: SheetDoc, sheet: string, rows: AxisLayout, cols: AxisLayout) {
  const rowAt = new Map(rows.ids.map((id, index) => [id, index]));
  const colAt = new Map(cols.ids.map((id, index) => [id, index]));
  const spans = new Map<string, { top: number; left: number; bottom: number; right: number }>();
  const covered = new Set<string>();
  for (const merge of doc.sheet[sheet]!.merges) {
    const [top, bottom, left, right] = [
      rowAt.get(merge.r1),
      rowAt.get(merge.r2),
      colAt.get(merge.c1),
      colAt.get(merge.c2),
    ];
    if (top === undefined || bottom === undefined || left === undefined || right === undefined)
      continue;
    spans.set(key(top, left), { top, left, bottom, right });
    for (let row = top; row <= bottom; row++)
      for (let col: number = left; col <= right; col++)
        if (row !== top || col !== left) covered.add(key(row, col));
  }
  return { spans, covered };
}

/**
 * A sheet's cells, drawn only where the viewport is. Scrolling is the
 * browser's own; headers stay put by sticking. Selection is by IDs and
 * reported up: the grid owns no document state.
 */
export function SheetGrid({
  doc,
  sheet,
  values,
  locale,
  selection,
  onSelectionChange,
  label,
}: SheetGridProps) {
  const gridId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, left: 0, ...FALLBACK });
  const data = doc.sheet[sheet]!;
  const rows = useMemo(
    () => axisLayout(data.rows, data.rowProps, rowPx),
    [data.rows, data.rowProps],
  );
  const cols = useMemo(
    () => axisLayout(data.cols, data.colProps, columnPx),
    [data.cols, data.colProps],
  );
  const merges = useMemo(() => mergeIndex(doc, sheet, rows, cols), [doc, sheet, rows, cols]);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setViewport({
      top: element.scrollTop,
      left: element.scrollLeft,
      width: element.clientWidth || FALLBACK.width,
      height: element.clientHeight || FALLBACK.height,
    });
  }, []);
  useLayoutEffect(() => {
    measure();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  const frame = useRef(0);
  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  }, [measure]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const rowIndex = useMemo(() => new Map(rows.ids.map((id, index) => [id, index])), [rows]);
  const colIndex = useMemo(() => new Map(cols.ids.map((id, index) => [id, index])), [cols]);
  const head = selection
    ? { row: rowIndex.get(selection.head.r) ?? 0, col: colIndex.get(selection.head.c) ?? 0 }
    : null;
  const anchor = selection
    ? { row: rowIndex.get(selection.anchor.r) ?? 0, col: colIndex.get(selection.anchor.c) ?? 0 }
    : null;
  const box =
    head && anchor
      ? {
          top: Math.min(head.row, anchor.row),
          bottom: Math.max(head.row, anchor.row),
          left: Math.min(head.col, anchor.col),
          right: Math.max(head.col, anchor.col),
        }
      : null;

  const select = useCallback(
    (row: number, col: number, extend: boolean) => {
      const at = { r: rows.ids[row]!, c: cols.ids[col]! };
      onSelectionChange({ anchor: extend && selection ? selection.anchor : at, head: at });
    },
    [cols.ids, onSelectionChange, rows.ids, selection],
  );
  /** Scrolls just enough to show a cell past the headers. */
  const reveal = useCallback(
    (row: number, col: number) => {
      const element = scroller.current;
      if (!element) return;
      const height = element.clientHeight || FALLBACK.height;
      const width = element.clientWidth || FALLBACK.width;
      const [top, bottom] = [rows.starts[row]!, rows.starts[row + 1]!];
      const [left, right] = [cols.starts[col]!, cols.starts[col + 1]!];
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom + HEADER_ROW_PX > element.scrollTop + height)
        element.scrollTop = bottom + HEADER_ROW_PX - height;
      if (left < element.scrollLeft) element.scrollLeft = left;
      else if (right + HEADER_COLUMN_PX > element.scrollLeft + width)
        element.scrollLeft = right + HEADER_COLUMN_PX - width;
    },
    [cols.starts, rows.starts],
  );

  const onKeyDown = (event: KeyboardEvent) => {
    if (!head) return;
    const page = Math.max(1, Math.floor(viewport.height / 20) - 1);
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-page, 0],
      PageDown: [page, 0],
      Enter: [event.shiftKey ? -1 : 1, 0],
      Tab: [0, event.shiftKey ? -1 : 1],
    };
    let target: [number, number] | null = null;
    const move = moves[event.key];
    if (move) {
      const jump = event.metaKey || event.ctrlKey;
      target = [
        jump && move[0] ? (move[0] < 0 ? 0 : rows.ids.length - 1) : head.row + move[0],
        jump && move[1] ? (move[1] < 0 ? 0 : cols.ids.length - 1) : head.col + move[1],
      ];
    } else if (event.key === "Home") target = [event.ctrlKey || event.metaKey ? 0 : head.row, 0];
    if (!target) return;
    event.preventDefault();
    const row = Math.min(rows.ids.length - 1, Math.max(0, target[0]));
    const col = Math.min(cols.ids.length - 1, Math.max(0, target[1]));
    const extend = event.shiftKey && event.key !== "Enter" && event.key !== "Tab";
    select(row, col, extend);
    reveal(row, col);
  };

  const dragging = useRef(false);
  const cellAt = (event: PointerEvent) => {
    const rect = content.current!.getBoundingClientRect();
    return {
      row: rows.indexAt(event.clientY - rect.top),
      col: cols.indexAt(event.clientX - rect.left),
    };
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !rows.ids.length || !cols.ids.length) return;
    const at = cellAt(event);
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    select(at.row, at.col, event.shiftKey);
    scroller.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging.current) return;
    const at = cellAt(event);
    if (head && (at.row !== head.row || at.col !== head.col)) select(at.row, at.col, true);
  };
  const stopDragging = () => {
    dragging.current = false;
  };

  const visibleRows = visibleRange(rows, viewport.top, viewport.height);
  const visibleCols = visibleRange(cols, viewport.left, viewport.width);
  const cells: ReactNode[] = [];
  const drawn = new Set<string>();
  const sheetCells = data.cells;
  const draw = (row: number, col: number, overflowTo: number) => {
    const span = merges.spans.get(key(row, col));
    const r = rows.ids[row]!;
    const c = cols.ids[col]!;
    const cell = sheetCells[r]?.[c];
    const style = cellStyle(cell?.s);
    const value = values.value(sheet, r, c);
    const shown = cellDisplay(value, style, locale);
    const bottom = span ? span.bottom : row;
    const right = span ? span.right : overflowTo;
    const active = head?.row === row && head.col === col;
    drawn.add(key(row, col));
    cells.push(
      <div
        key={key(row, col)}
        id={active ? `${gridId}-active` : undefined}
        role="gridcell"
        aria-rowindex={row + 1}
        aria-colindex={col + 1}
        aria-selected={active || undefined}
        className="border-border text-foreground absolute flex overflow-hidden border-r border-b px-1 text-sm leading-tight whitespace-pre"
        style={{
          top: rows.starts[row],
          left: cols.starts[col],
          height: rows.starts[bottom + 1]! - rows.starts[row]!,
          width: cols.starts[right + 1]! - cols.starts[col]!,
          alignItems:
            style.vertical === "top"
              ? "flex-start"
              : style.vertical === "center"
                ? "center"
                : "flex-end",
          justifyContent:
            shown.align === "right"
              ? "flex-end"
              : shown.align === "center"
                ? "center"
                : "flex-start",
          textAlign: shown.align,
          zIndex: right > col || span ? 1 : undefined,
          ...(right > col && !style.fill ? { backgroundColor: "var(--background)" } : {}),
          ...cellCss(style),
          ...(shown.color ? { color: shown.color } : {}),
        }}
      >
        {shown.text}
      </div>,
    );
  };
  for (let row = visibleRows.first; row <= visibleRows.last; row++)
    for (let col = visibleCols.first; col <= visibleCols.last; col++) {
      if (drawn.has(key(row, col))) continue;
      if (merges.covered.has(key(row, col))) continue;
      // Text runs on over empty cells to its right, as in Excel, unless it wraps.
      let overflowTo = col;
      const r = rows.ids[row]!;
      const value = values.value(sheet, r, cols.ids[col]!);
      const style = cellStyle(sheetCells[r]?.[cols.ids[col]!]?.s);
      if (typeof value === "string" && !style.wrap && (style.horizontal ?? "left") === "left") {
        while (
          overflowTo + 1 <= visibleCols.last &&
          !merges.covered.has(key(row, overflowTo + 1)) &&
          !merges.spans.has(key(row, overflowTo + 1)) &&
          values.value(sheet, r, cols.ids[overflowTo + 1]!) === null
        )
          overflowTo++;
        for (let skip = col + 1; skip <= overflowTo; skip++) drawn.add(key(row, skip));
      }
      draw(row, col, overflowTo);
    }
  // Merges starting above or left of the window still show where they reach into it.
  for (const span of merges.spans.values())
    if (
      !drawn.has(key(span.top, span.left)) &&
      span.bottom >= visibleRows.first &&
      span.top <= visibleRows.last &&
      span.right >= visibleCols.first &&
      span.left <= visibleCols.last
    )
      draw(span.top, span.left, span.left);
  // The active cell stays in the tree when scrolled away, so assistive tech still finds it.
  if (head && !drawn.has(key(head.row, head.col)) && rows.ids.length && cols.ids.length)
    draw(head.row, head.col, head.col);

  const columnHeaders: ReactNode[] = [];
  for (let col = visibleCols.first; col <= visibleCols.last; col++) {
    const inSelection = box && col >= box.left && col <= box.right;
    columnHeaders.push(
      <div
        key={col}
        role="columnheader"
        className={`border-border text-muted-foreground absolute top-0 flex h-full items-center justify-center border-r border-b text-xs ${inSelection ? "bg-accent text-accent-foreground" : "bg-muted"}`}
        style={{ left: HEADER_COLUMN_PX + cols.starts[col]!, width: cols.size(col) }}
      >
        {columnLetters(col + 1)}
      </div>,
    );
  }
  const rowHeaders: ReactNode[] = [];
  for (let row = visibleRows.first; row <= visibleRows.last; row++) {
    const inSelection = box && row >= box.top && row <= box.bottom;
    rowHeaders.push(
      <div
        key={row}
        role="rowheader"
        className={`border-border text-muted-foreground absolute left-0 flex w-full items-center justify-center border-r border-b text-xs ${inSelection ? "bg-accent text-accent-foreground" : "bg-muted"}`}
        style={{ top: rows.starts[row], height: rows.size(row) }}
      >
        {row + 1}
      </div>,
    );
  }

  const selectionBox = box && (
    <div
      aria-hidden
      className="border-primary bg-primary/10 pointer-events-none absolute z-10 border-2"
      style={{
        top: rows.starts[box.top],
        left: cols.starts[box.left],
        height: rows.starts[box.bottom + 1]! - rows.starts[box.top]!,
        width: cols.starts[box.right + 1]! - cols.starts[box.left]!,
      }}
    />
  );

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label={label}
      aria-rowcount={rows.ids.length}
      aria-colcount={cols.ids.length}
      aria-multiselectable
      aria-activedescendant={head ? `${gridId}-active` : undefined}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      className="bg-background focus-visible:ring-ring relative h-full w-full overflow-auto outline-none focus-visible:ring-2"
    >
      <div
        className="relative"
        style={{ width: HEADER_COLUMN_PX + cols.total, height: HEADER_ROW_PX + rows.total }}
      >
        <div className="sticky top-0 z-30" style={{ height: HEADER_ROW_PX }}>
          <div
            className="border-border bg-muted sticky left-0 z-10 border-r border-b"
            style={{ width: HEADER_COLUMN_PX, height: HEADER_ROW_PX }}
          />
          {columnHeaders}
        </div>
        <div className="sticky left-0 z-20" style={{ width: HEADER_COLUMN_PX, height: rows.total }}>
          {rowHeaders}
        </div>
        <div
          ref={content}
          className="absolute"
          style={{
            top: HEADER_ROW_PX,
            left: HEADER_COLUMN_PX,
            width: cols.total,
            height: rows.total,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
        >
          {cells}
          {selectionBox}
        </div>
      </div>
    </div>
  );
}
