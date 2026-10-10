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
import type { Axis, SheetDoc } from "@chat/sheet/model";
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

/** A cell being typed into. Typing a fresh value lets arrow keys move on; editing one moves the caret. */
export interface CellEditing {
  readonly at: CellRef;
  readonly text: string;
  readonly mode: "type" | "edit";
}
/** What the keyboard asks of the sheet; the app decides what each writes. */
export type GridCommand =
  | { readonly kind: "clear" | "undo" | "redo" | "find" }
  | { readonly kind: "fill"; readonly direction: "down" | "right" }
  | { readonly kind: "toggle"; readonly property: "bold" | "italic" };
/** Someone else's selection, drawn in their colour. */
export interface GridDecoration {
  readonly key: string;
  readonly selection: SheetSelection;
  readonly color: string;
  /** A person's name beside their selection; none for a highlight such as a find match. */
  readonly label?: string;
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
  /** Without editing handlers, or with this set, the grid only reads. */
  readonly readOnly?: boolean;
  readonly editing?: CellEditing | null;
  readonly onEditingChange?: (editing: CellEditing | null) => void;
  /** A finished edit: what was typed into the cell. */
  readonly onCommit?: (at: CellRef, text: string) => void;
  /** What editing a cell starts from: its formula or value as typed. */
  readonly editSource?: (at: CellRef) => string;
  readonly onCommand?: (command: GridCommand) => void;
  /** The text a copy or cut puts on the clipboard, or null for nothing. */
  readonly onCopy?: (cut: boolean) => string | null;
  readonly onPaste?: (text: string) => void;
  /** A row or column dragged to a new size, in pixels. */
  readonly onResize?: (axis: Axis, id: string, px: number) => void;
  readonly decorations?: readonly GridDecoration[];
}

/** jsdom and a hidden panel measure nothing; a typical panel's size stands in. */
const FALLBACK = { width: 960, height: 640 };
const key = (row: number, col: number) => `${row}:${col}`;
const NO_DECORATIONS: readonly GridDecoration[] = [];

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
  readOnly = false,
  editing = null,
  onEditingChange,
  onCommit,
  editSource,
  onCommand,
  onCopy,
  onPaste,
  onResize,
  decorations = NO_DECORATIONS,
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
  // Frozen up to and including these: the rows and columns that stay while the rest scrolls.
  const frozenRows = data.freeze.row ? (rowIndex.get(data.freeze.row) ?? -1) + 1 : 0;
  const frozenCols = data.freeze.col ? (colIndex.get(data.freeze.col) ?? -1) + 1 : 0;
  const frozenHeight = rows.starts[frozenRows] ?? 0;
  const frozenWidth = cols.starts[frozenCols] ?? 0;
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
      // A frozen cell is always in view; the rest scrolls clear of the frozen panes.
      if (row >= frozenRows) {
        if (top - frozenHeight < element.scrollTop) element.scrollTop = top - frozenHeight;
        else if (bottom + HEADER_ROW_PX > element.scrollTop + height)
          element.scrollTop = bottom + HEADER_ROW_PX - height;
      }
      if (col >= frozenCols) {
        if (left - frozenWidth < element.scrollLeft) element.scrollLeft = left - frozenWidth;
        else if (right + HEADER_COLUMN_PX > element.scrollLeft + width)
          element.scrollLeft = right + HEADER_COLUMN_PX - width;
      }
    },
    [cols.starts, rows.starts, frozenRows, frozenCols, frozenHeight, frozenWidth],
  );

  // A selection set from outside, as a find does, is scrolled into view like one moved by key.
  const headRow = head?.row;
  const headCol = head?.col;
  useEffect(() => {
    if (headRow !== undefined && headCol !== undefined) reveal(headRow, headCol);
  }, [headRow, headCol, reveal]);

  const writable = !readOnly && !!onEditingChange && !!onCommit;
  const beginEdit = (text: string | null) => {
    if (!writable || !selection) return;
    const at = selection.head;
    onEditingChange!({
      at,
      text: text ?? editSource?.(at) ?? "",
      mode: text === null ? "edit" : "type",
    });
  };
  // The edit just ended: focus leaving its input afterwards must not end it again.
  const ended = useRef<CellEditing | null>(null);
  /** Ends an edit, writing it, then moves on as Enter or Tab would. */
  const commit = (rowStep: number, colStep: number) => {
    if (!editing || ended.current === editing) return;
    ended.current = editing;
    onCommit!(editing.at, editing.text);
    onEditingChange!(null);
    const row = rowIndex.get(editing.at.r);
    const col = colIndex.get(editing.at.c);
    if (row !== undefined && col !== undefined) {
      const next = {
        row: Math.min(rows.ids.length - 1, Math.max(0, row + rowStep)),
        col: Math.min(cols.ids.length - 1, Math.max(0, col + colStep)),
      };
      select(next.row, next.col, false);
      reveal(next.row, next.col);
    }
    scroller.current?.focus({ preventScroll: true });
  };
  const cancel = () => {
    ended.current = editing;
    onEditingChange?.(null);
    scroller.current?.focus({ preventScroll: true });
  };
  const onEditorKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (event.key === "Enter") {
      event.preventDefault();
      commit(event.shiftKey ? -1 : 1, 0);
    } else if (event.key === "Tab") {
      event.preventDefault();
      commit(0, event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (editing?.mode === "type" && arrows[event.key]) {
      event.preventDefault();
      commit(...arrows[event.key]!);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!head) return;
    const command = event.metaKey || event.ctrlKey;
    // Find reads, so it works in a sheet that only reads.
    if (command && !event.altKey && event.key.toLowerCase() === "f" && onCommand) {
      event.preventDefault();
      onCommand({ kind: "find" });
      return;
    }
    if (writable && command && !event.altKey) {
      const lower = event.key.toLowerCase();
      const found: GridCommand | null =
        lower === "z"
          ? { kind: event.shiftKey ? "redo" : "undo" }
          : lower === "y"
            ? { kind: "redo" }
            : lower === "d"
              ? { kind: "fill", direction: "down" }
              : lower === "r"
                ? { kind: "fill", direction: "right" }
                : lower === "b"
                  ? { kind: "toggle", property: "bold" }
                  : lower === "i"
                    ? { kind: "toggle", property: "italic" }
                    : null;
      if (found) {
        event.preventDefault();
        onCommand?.(found);
        return;
      }
    }
    if (writable && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      onCommand?.({ kind: "clear" });
      return;
    }
    if (writable && event.key === "F2") {
      event.preventDefault();
      beginEdit(null);
      return;
    }
    // A printable key starts typing a fresh value, as in Excel.
    if (writable && event.key.length === 1 && !command && !event.altKey) {
      event.preventDefault();
      beginEdit(event.key);
      return;
    }
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
  // Every pane lies on the same coordinates as the content, so its own box locates a cell.
  const cellAt = (event: PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      row: rows.indexAt(event.clientY - rect.top),
      col: cols.indexAt(event.clientX - rect.left),
    };
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!rows.ids.length || !cols.ids.length) return;
    const at = cellAt(event);
    // A right click inside the selection keeps it for the menu it opens.
    if (event.button === 2) {
      const inside =
        box &&
        at.row >= box.top &&
        at.row <= box.bottom &&
        at.col >= box.left &&
        at.col <= box.right;
      if (!inside) select(at.row, at.col, false);
      return;
    }
    if (event.button !== 0) return;
    if (editing) commit(0, 0);
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

  // A header edge dragged: the size follows the pointer, and is reported once let go.
  const [resizing, setResizing] = useState<{
    axis: Axis;
    index: number;
    start: number;
    size: number;
  } | null>(null);
  const resizeHandle = (axis: Axis, index: number) =>
    writable && onResize ? (
      <div
        aria-hidden
        className={
          axis === "columns"
            ? "absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize"
            : "absolute -bottom-1 left-0 z-10 h-2 w-full cursor-row-resize"
        }
        onPointerDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const layout = axis === "columns" ? cols : rows;
          setResizing({
            axis,
            index,
            start: axis === "columns" ? event.clientX : event.clientY,
            size: layout.size(index),
          });
        }}
        onPointerMove={(event) => {
          if (!resizing) return;
          const delta =
            (resizing.axis === "columns" ? event.clientX : event.clientY) - resizing.start;
          setResizing({
            ...resizing,
            start: resizing.start + delta,
            size: Math.max(4, resizing.size + delta),
          });
        }}
        onPointerUp={() => {
          if (!resizing) return;
          const layout = resizing.axis === "columns" ? cols : rows;
          onResize(resizing.axis, layout.ids[resizing.index]!, Math.round(resizing.size));
          setResizing(null);
        }}
      />
    ) : null;

  const visibleRows = visibleRange(rows, viewport.top, viewport.height);
  const visibleCols = visibleRange(cols, viewport.left, viewport.width);
  const sheetCells = data.cells;
  /**
   * The cells of one pane: rows and columns in the given ranges. Only the
   * scrolling pane's cells are named for assistive tech and keep the active
   * cell mounted; the frozen panes repeat theirs over it.
   */
  const paneCells = (
    rowRange: { first: number; last: number },
    colRange: { first: number; last: number },
    main: boolean,
  ) => {
    const cells: ReactNode[] = [];
    const drawn = new Set<string>();
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
      const active = main && head?.row === row && head.col === col;
      drawn.add(key(row, col));
      cells.push(
        <div
          key={key(row, col)}
          id={active ? `${gridId}-active` : undefined}
          role={main ? "gridcell" : undefined}
          aria-rowindex={main ? row + 1 : undefined}
          aria-colindex={main ? col + 1 : undefined}
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
    for (let row = rowRange.first; row <= rowRange.last; row++)
      for (let col = colRange.first; col <= colRange.last; col++) {
        if (drawn.has(key(row, col))) continue;
        if (merges.covered.has(key(row, col))) continue;
        // Text runs on over empty cells to its right, as in Excel, unless it wraps.
        let overflowTo = col;
        const r = rows.ids[row]!;
        const value = values.value(sheet, r, cols.ids[col]!);
        const style = cellStyle(sheetCells[r]?.[cols.ids[col]!]?.s);
        if (typeof value === "string" && !style.wrap && (style.horizontal ?? "left") === "left") {
          while (
            overflowTo + 1 <= colRange.last &&
            !merges.covered.has(key(row, overflowTo + 1)) &&
            !merges.spans.has(key(row, overflowTo + 1)) &&
            values.value(sheet, r, cols.ids[overflowTo + 1]!) === null
          )
            overflowTo++;
          for (let skip = col + 1; skip <= overflowTo; skip++) drawn.add(key(row, skip));
        }
        draw(row, col, overflowTo);
      }
    // Merges starting above or left of the pane still show where they reach into it.
    for (const span of merges.spans.values())
      if (
        !drawn.has(key(span.top, span.left)) &&
        span.bottom >= rowRange.first &&
        span.top <= rowRange.last &&
        span.right >= colRange.first &&
        span.left <= colRange.last
      )
        draw(span.top, span.left, span.left);
    // The active cell stays in the tree when scrolled away, so assistive tech still finds it.
    if (main && head && !drawn.has(key(head.row, head.col)) && rows.ids.length && cols.ids.length)
      draw(head.row, head.col, head.col);
    return cells;
  };
  const cells = paneCells(visibleRows, visibleCols, true);

  const columnHeader = (col: number) => {
    const inSelection = box && col >= box.left && col <= box.right;
    return (
      <div
        key={col}
        role="columnheader"
        className={`border-border text-muted-foreground absolute top-0 flex items-center justify-center border-r border-b text-xs ${inSelection ? "bg-accent text-accent-foreground" : "bg-muted"}`}
        style={{
          left: HEADER_COLUMN_PX + cols.starts[col]!,
          width: cols.size(col),
          height: HEADER_ROW_PX,
        }}
      >
        {columnLetters(col + 1)}
        {resizeHandle("columns", col)}
      </div>
    );
  };
  /** A row's header; `offset` places it in the corner, below the column headers. */
  const rowHeader = (row: number, offset = 0) => {
    const inSelection = box && row >= box.top && row <= box.bottom;
    return (
      <div
        key={row}
        role="rowheader"
        className={`border-border text-muted-foreground absolute left-0 flex items-center justify-center border-r border-b text-xs ${inSelection ? "bg-accent text-accent-foreground" : "bg-muted"}`}
        style={{ top: offset + rows.starts[row]!, height: rows.size(row), width: HEADER_COLUMN_PX }}
      >
        {row + 1}
        {resizeHandle("rows", row)}
      </div>
    );
  };
  const columnHeaders: ReactNode[] = [];
  for (let col = visibleCols.first; col <= visibleCols.last; col++)
    columnHeaders.push(columnHeader(col));
  const rowHeaders: ReactNode[] = [];
  for (let row = visibleRows.first; row <= visibleRows.last; row++) rowHeaders.push(rowHeader(row));

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

  /** A selection's rectangle in content pixels, or null when its cells are gone. */
  const indexOf = (ref: CellRef) => ({ row: rowIndex.get(ref.r), col: colIndex.get(ref.c) });
  const rectOf = (of: SheetSelection) => {
    const [a, b] = [indexOf(of.anchor), indexOf(of.head)];
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
  const others = decorations.flatMap((decoration) => {
    const rect = rectOf(decoration.selection);
    return rect
      ? [
          <div
            key={decoration.key}
            aria-hidden
            className="pointer-events-none absolute z-10 border-2"
            style={{ ...rect, borderColor: decoration.color }}
          >
            {decoration.label ? (
              <span
                className="absolute -top-4 left-0 rounded-sm px-1 text-[10px] leading-4 whitespace-nowrap text-white"
                style={{ backgroundColor: decoration.color }}
              >
                {decoration.label}
              </span>
            ) : null}
          </div>,
        ]
      : [];
  });
  const editorRect =
    editing && rowIndex.has(editing.at.r) && colIndex.has(editing.at.c)
      ? rectOf({ anchor: editing.at, head: editing.at })
      : null;
  /** Which pane the cell being edited is drawn in, so its input sits over it. */
  const editingPane = (() => {
    if (!editing) return null;
    const row = rowIndex.get(editing.at.r) ?? 0;
    const col = colIndex.get(editing.at.c) ?? 0;
    return row < frozenRows
      ? col < frozenCols
        ? "corner"
        : "top"
      : col < frozenCols
        ? "left"
        : "main";
  })();
  const editor =
    editing && editorRect ? (
      <input
        aria-label="Cell content"
        autoFocus
        value={editing.text}
        onChange={(event) => onEditingChange?.({ ...editing, text: event.target.value })}
        onKeyDown={onEditorKeyDown}
        onBlur={(event) => {
          // Focus moving to the formula bar keeps the edit going there.
          if (
            !(event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.sheetEditor)
          )
            commit(0, 0);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className="bg-background text-foreground border-primary absolute z-40 border-2 px-1 text-sm outline-none"
        style={{
          ...editorRect,
          width: Math.max(editorRect.width, (editing.text.length + 2) * 8),
        }}
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
      aria-hidden={editingPane !== name || undefined}
      className="bg-background absolute overflow-hidden"
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
      {others}
      {selectionBox}
      {editingPane === name ? editor : null}
    </div>
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
      onDoubleClick={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        beginEdit(null);
      }}
      onCopy={(event) => {
        if (editing || !onCopy) return;
        const text = onCopy(false);
        if (text === null) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
      }}
      onCut={(event) => {
        if (editing || !onCopy || !writable) return;
        const text = onCopy(true);
        if (text === null) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
      }}
      onPaste={(event) => {
        if (editing || !onPaste || !writable) return;
        event.preventDefault();
        onPaste(event.clipboardData.getData("text/plain"));
      }}
      className="bg-background focus-visible:ring-ring relative h-full w-full overflow-auto outline-none focus-visible:ring-2"
    >
      <div
        className="relative"
        style={{ width: HEADER_COLUMN_PX + cols.total, height: HEADER_ROW_PX + rows.total }}
      >
        <div className="sticky top-0 z-30" style={{ height: HEADER_ROW_PX + frozenHeight }}>
          <div
            className="sticky left-0 z-10"
            style={{ width: HEADER_COLUMN_PX + frozenWidth, height: HEADER_ROW_PX + frozenHeight }}
          >
            <div
              className="border-border bg-muted absolute top-0 left-0 border-r border-b"
              style={{ width: HEADER_COLUMN_PX, height: HEADER_ROW_PX }}
            />
            {Array.from({ length: frozenCols }, (_, col) => columnHeader(col))}
            {Array.from({ length: frozenRows }, (_, row) => rowHeader(row, HEADER_ROW_PX))}
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
          className="sticky left-0 z-20"
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
          {others}
          {selectionBox}
          {editingPane === "main" ? editor : null}
          {resizing ? (
            <div
              aria-hidden
              className="bg-primary pointer-events-none absolute z-50"
              style={
                resizing.axis === "columns"
                  ? {
                      top: 0,
                      bottom: 0,
                      width: 1,
                      left: cols.starts[resizing.index]! + resizing.size,
                    }
                  : {
                      left: 0,
                      right: 0,
                      height: 1,
                      top: rows.starts[resizing.index]! + resizing.size,
                    }
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
