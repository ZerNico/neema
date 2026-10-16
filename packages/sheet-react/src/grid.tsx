import { cellStyle } from "@chat/sheet/style";
import {
  useCallback,
  useEffectEvent,
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
import type { Scalar } from "@chat/sheet/engine/values";
import type { SheetLocale } from "@chat/sheet/locales";
import { selectionText } from "./copy.ts";
import { mergeAnchor, safeLink } from "./display.ts";
import type { GridSheet } from "./grid-model.ts";
import { occupiedColumns } from "./grid-spill.ts";
import {
  HEADER_COLUMN_PX,
  HEADER_ROW_PX,
  axisLayout,
  columnPx,
  rowPx,
  visibleRange,
} from "./layout.ts";
import { bandRange, PaneCells, rowHeaderBands, type PaneDrawing } from "./grid-cells.tsx";
import {
  adding,
  dataEdge,
  mergeIndex,
  onSheet,
  regionAround,
  usedEnd,
  type FilledCells,
} from "./grid-navigation.ts";
import type { GridOverlay } from "./grid-types.ts";
import { GridOverlays } from "./grid-overlays.tsx";
import type { CellLook } from "./looks.ts";
import type { SheetSelection } from "./selection.ts";

export type { GridOverlay } from "./grid-types.ts";
export type { GridSheet } from "./grid-model.ts";
export type { CellRef, SheetSelection } from "./selection.ts";

export interface SheetGridProps {
  readonly sheet: GridSheet;
  /** What a cell holds, by row and column key; null for nothing. */
  readonly value: (r: string, c: string) => Scalar;
  readonly locale: SheetLocale;
  readonly selection: SheetSelection;
  readonly onSelectionChange: (selection: SheetSelection) => void;
  /** The grid's accessible name. */
  readonly label: string;
  /** How conditional formats show cells, by `r|c`. */
  readonly looks?: ReadonlyMap<string, CellLook>;
  /** Charts and pictures over the cells. */
  readonly overlays?: readonly GridOverlay[];
  /** A copy of more cells than `COPY_CELLS`, which copies nothing. */
  readonly onCopyRefused?: () => void;
}

/** jsdom and a hidden panel measure nothing; a typical panel's size stands in. */
const FALLBACK = { width: 960, height: 640 };
const NONE_VISIBLE = { first: 0, last: -1 };
/** How far a reveal may scroll and still glide there. */
const GLIDE_PX = 240;
const NO_OVERLAYS: readonly GridOverlay[] = [];
const NO_LOOKS: ReadonlyMap<string, CellLook> = new Map();

/**
 * A sheet's cells, read-only, drawn only where the viewport is. Scrolling is
 * the browser's own; headers and frozen panes stay put by sticking. The
 * selection is reported up, and a copy takes the selected cells as shown.
 */
export function SheetGrid({
  sheet,
  value,
  locale,
  selection,
  onSelectionChange,
  label,
  looks = NO_LOOKS,
  overlays = NO_OVERLAYS,
  onCopyRefused,
}: SheetGridProps) {
  const gridId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Unmeasured until the layout effect reads the grid's box, before the first paint. Until then
  // no cells are drawn: drawing a guessed viewport's would draw them all twice on opening.
  const [measured, setViewport] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const viewport = measured ?? { top: 0, left: 0, ...FALLBACK };
  const rows = useMemo(
    () => axisLayout(sheet.rows, sheet.rowProps, rowPx),
    [sheet.rows, sheet.rowProps],
  );
  const cols = useMemo(
    () => axisLayout(sheet.cols, sheet.colProps, columnPx),
    [sheet.cols, sheet.colProps],
  );
  const merges = useMemo(() => mergeIndex(sheet, rows, cols), [sheet, rows, cols]);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const next = {
      top: element.scrollTop,
      left: element.scrollLeft,
      width: element.clientWidth || FALLBACK.width,
      height: element.clientHeight || FALLBACK.height,
    };
    // The grid is drawn a viewport beyond each edge, so a scroll that stays within half of
    // that keeps it as drawn: most scroll events render nothing, and none reaches blank cells.
    setViewport((current) =>
      current &&
      current.width === next.width &&
      current.height === next.height &&
      Math.abs(current.top - next.top) < next.height / 2 &&
      Math.abs(current.left - next.left) < next.width / 4
        ? current
        : next,
    );
  }, []);
  useLayoutEffect(() => {
    measure();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const rowIndex = useMemo(() => new Map(rows.ids.map((id, index) => [id, index])), [rows]);
  const colIndex = useMemo(() => new Map(cols.ids.map((id, index) => [id, index])), [cols]);
  const filled: FilledCells = {
    rows: rows.ids.length,
    cols: cols.ids.length,
    at: (row, col) => value(rows.ids[row]!, cols.ids[col]!) !== null,
  };
  // Frozen up to and including these: the rows and columns that stay while the rest scrolls.
  // Frozen panes are drawn whole, so they keep to what fits in three quarters of the window,
  // which leaves room to scroll and bounds what a file's freeze can make the page draw.
  const frozenRows = Math.min(
    sheet.freeze.row ? (rowIndex.get(sheet.freeze.row) ?? -1) + 1 : 0,
    rows.indexAt((viewport.height * 3) / 4),
  );
  const frozenCols = Math.min(
    sheet.freeze.col ? (colIndex.get(sheet.freeze.col) ?? -1) + 1 : 0,
    cols.indexAt((viewport.width * 3) / 4),
  );
  const frozenHeight = rows.starts[frozenRows] ?? 0;
  const frozenWidth = cols.starts[frozenCols] ?? 0;
  const head = {
    row: rowIndex.get(selection.head.r) ?? 0,
    col: colIndex.get(selection.head.c) ?? 0,
  };
  const anchor = {
    row: rowIndex.get(selection.anchor.r) ?? 0,
    col: colIndex.get(selection.anchor.c) ?? 0,
  };
  const box = {
    top: Math.min(head.row, anchor.row),
    bottom: Math.max(head.row, anchor.row),
    left: Math.min(head.col, anchor.col),
    right: Math.max(head.col, anchor.col),
  };

  const select = (row: number, col: number, extend: boolean) => {
    const at = { r: rows.ids[row]!, c: cols.ids[col]! };
    // Extending keeps the other ranges; anything else starts over with one.
    onSelectionChange({
      anchor: extend ? selection.anchor : at,
      head: at,
      ...(extend && selection.more ? { more: selection.more } : {}),
    });
  };
  /** Selects a rectangle by indexes, the head at its far corner. */
  const selectBox = (
    from: { row: number; col: number },
    to: { row: number; col: number },
    more?: SheetSelection["more"],
  ) =>
    onSelectionChange({
      anchor: { r: rows.ids[from.row]!, c: cols.ids[from.col]! },
      head: { r: rows.ids[to.row]!, c: cols.ids[to.col]! },
      ...(more ? { more } : {}),
    });
  /** Scrolls just enough to show a cell past the headers and frozen panes. */
  const reveal = useCallback(
    (row: number, col: number) => {
      const element = scroller.current;
      if (!element) return;
      const height = element.clientHeight || FALLBACK.height;
      const width = element.clientWidth || FALLBACK.width;
      const [top, bottom] = [rows.starts[row]!, rows.starts[row + 1]!];
      const [left, right] = [cols.starts[col]!, cols.starts[col + 1]!];
      // A frozen cell is always in view; the rest scrolls clear of the frozen panes.
      let [y, x] = [element.scrollTop, element.scrollLeft];
      if (row >= frozenRows) {
        if (top - frozenHeight < y) y = top - frozenHeight;
        else if (bottom + HEADER_ROW_PX > y + height) y = bottom + HEADER_ROW_PX - height;
      }
      if (col >= frozenCols) {
        if (left - frozenWidth < x) x = left - frozenWidth;
        else if (right + HEADER_COLUMN_PX > x + width) x = right + HEADER_COLUMN_PX - width;
      }
      if (y === element.scrollTop && x === element.scrollLeft) return;
      // A step of a few cells glides, as Excel's does; a long jump lands at once.
      const near = Math.abs(y - element.scrollTop) + Math.abs(x - element.scrollLeft) <= GLIDE_PX;
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
      if (near && !still && typeof element.scrollTo === "function")
        element.scrollTo({ top: y, left: x, behavior: "smooth" });
      else {
        element.scrollTop = y;
        element.scrollLeft = x;
        // Instant jumps draw before paint. Smooth scrolling follows the actual scroll events.
        setViewport({ top: y, left: x, width, height });
      }
    },
    [cols.starts, rows.starts, frozenRows, frozenCols, frozenHeight, frozenWidth],
  );
  // A selection moved from outside is scrolled into view like one moved by key.
  const revealHead = useEffectEvent((row: number, col: number) => reveal(row, col));
  useLayoutEffect(() => revealHead(head.row, head.col), [head.row, head.col]);

  const onKeyDown = (event: KeyboardEvent) => {
    const command = event.metaKey || event.ctrlKey;
    // Ctrl+Backspace brings the active cell back into view.
    if (command && event.key === "Backspace") {
      event.preventDefault();
      reveal(head.row, head.col);
      return;
    }
    const lastRow = rows.ids.length - 1;
    const lastCol = cols.ids.length - 1;
    if (command && !event.altKey && event.key.toLowerCase() === "a") {
      // First the block of data around the cell, then, pressed again, the whole sheet.
      event.preventDefault();
      const region = regionAround(filled, head.row, head.col);
      const already =
        box.top === region.top &&
        box.bottom === region.bottom &&
        box.left === region.left &&
        box.right === region.right;
      if (already || (region.top === region.bottom && region.left === region.right))
        selectBox({ row: lastRow, col: lastCol }, { row: 0, col: 0 });
      else
        selectBox({ row: region.bottom, col: region.right }, { row: region.top, col: region.left });
      return;
    }
    if (event.key === " " && (event.shiftKey || event.ctrlKey) && !event.metaKey) {
      // Shift+Space selects the selection's rows, Ctrl+Space its columns.
      event.preventDefault();
      if (event.shiftKey && !event.ctrlKey)
        selectBox({ row: box.bottom, col: lastCol }, { row: box.top, col: 0 });
      else if (event.ctrlKey && !event.shiftKey)
        selectBox({ row: lastRow, col: box.right }, { row: 0, col: box.left });
      else selectBox({ row: lastRow, col: lastCol }, { row: 0, col: 0 });
      return;
    }
    const page = Math.max(1, Math.floor(viewport.height / 20) - 1);
    // Alt+PageUp and PageDown move a screen across.
    const pageAcross = Math.max(1, Math.floor(viewport.width / 64) - 1);
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: event.altKey ? [0, -pageAcross] : [-page, 0],
      PageDown: event.altKey ? [0, pageAcross] : [page, 0],
      Enter: [event.shiftKey ? -1 : 1, 0],
      Tab: [0, event.shiftKey ? -1 : 1],
    };
    let target: [number, number] | null = null;
    const move = moves[event.key];
    if (move && command && event.key.startsWith("Arrow")) {
      // From the selection's moving end, so Ctrl+Shift+Arrow keeps extending.
      target = [...dataEdge(filled, head.row, head.col, Math.sign(move[0]), Math.sign(move[1]))];
    } else if (move) {
      // Hidden rows and columns are stepped over, as Excel's arrows do.
      let [row, col] = [head.row + move[0], head.col + move[1]];
      const [down, right] = [Math.sign(move[0]), Math.sign(move[1])];
      if (down || right)
        while (onSheet(filled, row, col) && (!rows.size(row) || !cols.size(col)))
          [row, col] = [row + down, col + right];
      target = onSheet(filled, row, col) ? [row, col] : [head.row, head.col];
    } else if (event.key === "Home") target = [command ? 0 : head.row, 0];
    else if (event.key === "End" && command) target = [...usedEnd(sheet.cells, rowIndex, colIndex)];
    if (!target) return;
    event.preventDefault();
    const row = Math.min(lastRow, Math.max(0, target[0]));
    const col = Math.min(lastCol, Math.max(0, target[1]));
    select(row, col, event.shiftKey && event.key !== "Enter" && event.key !== "Tab");
    reveal(row, col);
  };

  const dragging = useRef(false);
  // Every pane lies on the same coordinates as the content, so its own box locates a cell.
  const cellAt = (event: PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      row: rows.indexAt(event.clientY - rect.top),
      col: cols.indexAt(event.clientX - rect.left),
    };
  };
  const inBox = (row: number, col: number) =>
    row >= box.top && row <= box.bottom && col >= box.left && col <= box.right;
  const onPointerDown = (event: PointerEvent) => {
    if (!rows.ids.length || !cols.ids.length) return;
    const at = cellAt(event);
    // A right click inside the selection keeps it for the menu it opens; outside, it picks the cell.
    if (event.button === 2) {
      if (!inBox(at.row, at.col)) select(at.row, at.col, false);
      return;
    }
    if (event.button !== 0) return;
    // Cmd or Ctrl and a click opens a cell's link, as in Excel.
    if (event.metaKey || event.ctrlKey) {
      const { r, c } = mergeAnchor(sheet, { r: rows.ids[at.row]!, c: cols.ids[at.col]! });
      const link = safeLink(cellStyle(sheet.cells[r]?.[c]?.s).link);
      if (link) {
        event.preventDefault();
        window.open(link, "_blank", "noopener,noreferrer");
        return;
      }
    }
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey)
      onSelectionChange(adding(selection, { r: rows.ids[at.row]!, c: cols.ids[at.col]! }));
    else select(at.row, at.col, event.shiftKey);
    scroller.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging.current) return;
    const at = cellAt(event);
    if (at.row !== head.row || at.col !== head.col) select(at.row, at.col, true);
  };
  const stopDragging = () => {
    dragging.current = false;
  };

  const visibleRows = measured
    ? bandRange(visibleRange(rows, viewport.top - viewport.height, viewport.height * 3), rows)
    : NONE_VISIBLE;
  const visibleCols = measured
    ? visibleRange(cols, viewport.left - viewport.width / 2, viewport.width * 2)
    : NONE_VISIBLE;
  const occupied = useMemo(
    () => occupiedColumns(sheet.cells, value, rows, cols),
    [sheet.cells, value, rows, cols],
  );
  const drawing: PaneDrawing = useMemo(
    () => ({
      gridId,
      cells: sheet.cells,
      value,
      locale,
      looks,
      rows,
      cols,
      merges,
      frozenCols,
      occupied,
    }),
    [gridId, sheet.cells, value, locale, looks, rows, cols, merges, frozenCols, occupied],
  );
  const paneCells = (
    rowRange: { first: number; last: number },
    colRange: { first: number; last: number },
    main: boolean,
  ) => (
    <PaneCells
      drawing={drawing}
      first={rowRange.first}
      last={rowRange.last}
      colFirst={colRange.first}
      colLast={colRange.last}
      main={main}
      activeRow={main ? head.row : -1}
      activeCol={main ? head.col : -1}
    />
  );

  /**
   * A header pressed: its whole column (or row) selected, Shift extending
   * from the selection's anchor, and a drag along the headers taking more.
   */
  const startHeaderSelect = (event: PointerEvent, axis: "rows" | "columns", index: number) => {
    if (!rows.ids.length || !cols.ids.length) return;
    const columns = axis === "columns";
    // A right click on a selected row or column keeps the selection for its menu; else it takes that one.
    if (event.button === 2) {
      const whole = columns
        ? box.top === 0 &&
          box.bottom === rows.ids.length - 1 &&
          index >= box.left &&
          index <= box.right
        : box.left === 0 &&
          box.right === cols.ids.length - 1 &&
          index >= box.top &&
          index <= box.bottom;
      if (!whole)
        if (columns) selectBox({ row: rows.ids.length - 1, col: index }, { row: 0, col: index });
        else selectBox({ row: index, col: cols.ids.length - 1 }, { row: index, col: 0 });
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    const anchorIndex = event.shiftKey ? (columns ? anchor.col : anchor.row) : index;
    // Cmd or Ctrl adds the rows or columns to what is selected; Shift extends the active range.
    const kept =
      event.metaKey || event.ctrlKey
        ? adding(selection, selection.head).more
        : event.shiftKey
          ? selection.more
          : undefined;
    const span = (to: number) =>
      // The active cell stays at the top (or left), so the sheet does not scroll to the end.
      columns
        ? selectBox({ row: rows.ids.length - 1, col: anchorIndex }, { row: 0, col: to }, kept)
        : selectBox({ row: anchorIndex, col: cols.ids.length - 1 }, { row: to, col: 0 }, kept);
    span(index);
    scroller.current?.focus({ preventScroll: true });
    const move = (next: globalThis.PointerEvent) => {
      const rect = content.current?.getBoundingClientRect();
      if (!rect) return;
      span(
        columns ? cols.indexAt(next.clientX - rect.left) : rows.indexAt(next.clientY - rect.top),
      );
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const columnHeader = (col: number) => {
    // A hidden column has no header; its neighbours meet where it was.
    if (!cols.size(col)) return null;
    const inSelection = col >= box.left && col <= box.right;
    return (
      <div
        key={col}
        role="columnheader"
        className={`border-border text-muted-foreground absolute flex cursor-default items-center justify-center border-r border-b text-xs ${inSelection ? "bg-accent text-accent-foreground" : "bg-muted"}`}
        style={{
          top: 0,
          left: HEADER_COLUMN_PX + cols.starts[col]!,
          width: cols.size(col),
          height: HEADER_ROW_PX,
        }}
        data-sheet-axis="columns"
        data-sheet-index={col}
      >
        {columnLetters(col + 1)}
      </div>
    );
  };
  const columnHeaders: ReactNode[] = [];
  for (let col = visibleCols.first; col <= visibleCols.last; col++)
    columnHeaders.push(columnHeader(col));
  const rowHeaders = rowHeaderBands(rows, visibleRows, box, 0);

  /** A range's rectangle in content pixels, or null when its cells are not on the sheet. */
  const rectOf = (range: { anchor: SheetSelection["anchor"]; head: SheetSelection["head"] }) => {
    const [a, b] = [
      { row: rowIndex.get(range.anchor.r), col: colIndex.get(range.anchor.c) },
      { row: rowIndex.get(range.head.r), col: colIndex.get(range.head.c) },
    ];
    if (a.row === undefined || a.col === undefined || b.row === undefined || b.col === undefined)
      return null;
    const [top, bottom] = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
    const [left, right] = [Math.min(a.col, b.col), Math.max(a.col, b.col)];
    return {
      top: rows.starts[top]!,
      left: cols.starts[left]!,
      height: rows.starts[bottom + 1]! - rows.starts[top]!,
      width: cols.starts[right + 1]! - cols.starts[left]!,
    };
  };
  // The other selected ranges, shaded as Excel shades them, without the active range's frame.
  const moreBoxes = (selection.more ?? []).flatMap((range) => {
    const rect = rectOf(range);
    return rect
      ? [
          <div
            key={`${range.anchor.r}:${range.anchor.c}:${range.head.r}:${range.head.c}`}
            aria-hidden
            className="border-primary/60 bg-primary/10 pointer-events-none absolute z-10 border"
            style={rect}
          />,
        ]
      : [];
  });
  const selectionRect = rectOf(selection);
  const selectionBox = selectionRect ? (
    <div
      aria-hidden
      className="border-primary bg-primary/10 pointer-events-none absolute z-10 border-2"
      style={selectionRect}
    />
  ) : null;

  const handlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: stopDragging,
    onPointerCancel: stopDragging,
  };
  /** A frozen pane: its cells over the content's own, on the same coordinates, opaque. */
  const pane = (
    name: "corner" | "top" | "left",
    rowRange: { first: number; last: number },
    colRange: { first: number; last: number },
  ) => (
    <div
      aria-hidden
      // Its own stacking layer: outlines inside stay under the headers, as in the content.
      className="bg-background absolute isolate cursor-cell overflow-hidden"
      style={{
        top: name === "left" ? 0 : HEADER_ROW_PX,
        left: HEADER_COLUMN_PX,
        width: name === "top" ? cols.total : frozenWidth,
        height: name === "left" ? rows.total : frozenHeight,
        // The line Excel draws where the frozen part ends.
        boxShadow:
          name === "top"
            ? "0 1px 0 var(--border)"
            : name === "left"
              ? "1px 0 0 var(--border)"
              : "1px 1px 0 var(--border)",
      }}
      {...handlers}
    >
      {paneCells(rowRange, colRange, false)}
      {moreBoxes}
      {selectionBox}
    </div>
  );

  return (
    <div
      ref={scroller}
      style={{ overflowAnchor: "none" }}
      role="grid"
      aria-label={label}
      aria-readonly
      aria-rowcount={rows.ids.length}
      aria-colcount={cols.ids.length}
      aria-multiselectable
      aria-activedescendant={`${gridId}-active`}
      tabIndex={0}
      onScroll={measure}
      onKeyDown={onKeyDown}
      onPointerDownCapture={(event) => {
        if (!(event.target instanceof Element)) return;
        const header = event.target.closest<HTMLElement>("[data-sheet-axis]");
        const axis = header?.dataset.sheetAxis;
        if (axis === "rows" || axis === "columns")
          startHeaderSelect(event, axis, Number(header!.dataset.sheetIndex));
      }}
      onCopy={(event) => {
        event.preventDefault();
        const text = selectionText(sheet, value, locale, selection);
        if (text === null) onCopyRefused?.();
        else event.clipboardData.setData("text/plain", text);
      }}
      // Text in cells is never selected by a drag, which selects cells instead.
      className="bg-background focus-visible:ring-ring relative h-full w-full overflow-auto outline-none select-none focus-visible:ring-2"
    >
      <div
        className="relative"
        style={{ width: HEADER_COLUMN_PX + cols.total, height: HEADER_ROW_PX + rows.total }}
      >
        {/* The header layers are opaque, so scrolled cells and charts pass under them. */}
        <div
          className="bg-background sticky top-0 z-30"
          style={{ height: HEADER_ROW_PX + frozenHeight }}
        >
          <div
            className="bg-background sticky left-0 z-10"
            style={{ width: HEADER_COLUMN_PX + frozenWidth, height: HEADER_ROW_PX + frozenHeight }}
          >
            <div
              role="button"
              aria-label="Select all"
              className="border-border bg-muted absolute cursor-default border-r border-b"
              style={{ top: 0, left: 0, width: HEADER_COLUMN_PX, height: HEADER_ROW_PX }}
              onPointerDown={(event) => {
                if (event.button !== 0 || !rows.ids.length || !cols.ids.length) return;
                event.preventDefault();
                selectBox(
                  { row: rows.ids.length - 1, col: cols.ids.length - 1 },
                  { row: 0, col: 0 },
                );
              }}
            />
            {Array.from({ length: frozenCols }, (_, col) => columnHeader(col))}
            {rowHeaderBands(rows, { first: 0, last: frozenRows - 1 }, box, HEADER_ROW_PX)}
            {frozenRows && frozenCols
              ? pane(
                  "corner",
                  { first: 0, last: frozenRows - 1 },
                  { first: 0, last: frozenCols - 1 },
                )
              : null}
          </div>
          {columnHeaders}
          {frozenRows ? pane("top", { first: 0, last: frozenRows - 1 }, visibleCols) : null}
        </div>
        <div
          className="bg-background sticky left-0 z-20"
          style={{
            width: HEADER_COLUMN_PX + frozenWidth,
            height: rows.total,
            marginTop: -frozenHeight,
          }}
        >
          {rowHeaders}
          {frozenCols ? pane("left", visibleRows, { first: 0, last: frozenCols - 1 }) : null}
        </div>
        <div
          ref={content}
          data-sheet-content=""
          // Its own stacking layer, so charts stay under the headers and frozen panes.
          className="absolute isolate cursor-cell"
          style={{
            top: HEADER_ROW_PX,
            left: HEADER_COLUMN_PX,
            width: cols.total,
            height: rows.total,
          }}
          {...handlers}
        >
          {paneCells(visibleRows, visibleCols, true)}
          {moreBoxes}
          {selectionBox}
          <GridOverlays
            overlays={overlays}
            rows={rows}
            cols={cols}
            rowIndex={rowIndex}
            colIndex={colIndex}
          />
        </div>
      </div>
    </div>
  );
}
