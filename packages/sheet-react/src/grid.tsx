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
import { serialOf } from "@chat/sheet/dates";
import { formatValue } from "@chat/sheet/number-format";
import type { SheetLocale } from "@chat/sheet/locales";
import type { SheetValues } from "@chat/sheet/model/calc";
import type { Axis, SheetDoc } from "@chat/sheet/model";
import type { CellLook } from "@chat/sheet/model/conditional";
import { cellCss, cellDisplay, cellStyle, safeLink } from "./display.ts";
import {
  HEADER_COLUMN_PX,
  HEADER_ROW_PX,
  axisLayout,
  columnPx,
  rowPx,
  textWidth,
  visibleRange,
  type AxisLayout,
} from "./layout.ts";
import type { OverlayCommand } from "./overlay-place.ts";
import { OverlayFrame } from "./overlay.tsx";
import {
  REF_COLORS,
  acceptCompletion,
  completionFor,
  formulaRefs,
  insertRef,
  pointable,
  toggleAbsolute,
} from "./formula-edit.ts";
import { FormulaPopup } from "./formula-popup.tsx";

export type { OverlayCommand } from "./overlay-place.ts";

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
/** A drag of the fill handle: how many cells past the selection, which way, Ctrl held or not. */
export interface GridFill {
  readonly direction: "down" | "up" | "right" | "left";
  /**
   * Cells to fill, or `"auto"` for a double-click: down as far as the data
   * beside it runs. Below zero, the handle was dragged back in: clear that
   * many of the selection's last rows (down) or columns (right).
   */
  readonly count: number | "auto";
  readonly mode: "auto" | "alternate";
}

export type GridCommand =
  | { readonly kind: "clear" | "undo" | "redo" | "find" | "filter" | "link" }
  | { readonly kind: "fill"; readonly direction: "down" | "right" }
  | { readonly kind: "toggle"; readonly property: "bold" | "italic" | "underline" | "strike" };
/** Someone else's selection, drawn in their colour. */
export interface GridDecoration {
  readonly key: string;
  readonly selection: SheetSelection;
  readonly color: string;
  /** A person's name beside their selection; none for a highlight such as a find match. */
  readonly label?: string;
  /** A corner mark on the cell instead of an outline, as a comment has. */
  readonly marker?: boolean;
}

/** A cell by its row and column indexes, as A1. */
const corner = (at: { row: number; col: number }) => `${columnLetters(at.col + 1)}${at.row + 1}`;

/** Something drawn over the cells from a cell's top-left corner, such as a chart. */
export interface GridOverlay {
  readonly key: string;
  readonly at: CellRef;
  readonly width: number;
  readonly height: number;
  readonly content: ReactNode;
  /** Its accessible name, such as "Sales chart". */
  readonly label: string;
  /** The smallest it may be resized to. */
  readonly min?: { readonly width: number; readonly height: number };
}

/** Where an overlay was moved or resized to: the cell under its top-left corner, and its size. */
export interface OverlayChange {
  readonly at: CellRef;
  readonly width: number;
  readonly height: number;
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
  /** An edit finished with Ctrl+Enter: what was typed, for every selected cell. */
  readonly onCommitSelection?: (text: string) => void;
  /** What editing a cell starts from: its formula or value as typed. */
  readonly editSource?: (at: CellRef) => string;
  readonly onCommand?: (command: GridCommand) => void;
  /** What a copy or cut puts on the clipboard, as text and as HTML, or null for nothing. */
  readonly onCopy?: (cut: boolean) => { text: string; html?: string } | null;
  /** A paste: the clipboard's text and HTML, and whether Cmd+Shift+V asked for values only. */
  readonly onPaste?: (clip: { text: string; html: string | null; values: boolean }) => void;
  /** A row or column dragged to a new size, in pixels. */
  readonly onResize?: (axis: Axis, id: string, px: number) => void;
  readonly decorations?: readonly GridDecoration[];
  readonly overlays?: readonly GridOverlay[];
  /** The overlay selected instead of cells, by key. */
  readonly selectedOverlay?: string | null;
  readonly onOverlaySelect?: (key: string | null) => void;
  /** Without this, overlays can be selected but not moved, resized or deleted. */
  readonly onOverlayChange?: (key: string, change: OverlayChange) => void;
  readonly onOverlayCommand?: (key: string, command: OverlayCommand) => void;
  /** Without this, the selection has no fill handle. */
  readonly onFill?: (fill: GridFill) => void;
  /** Drawn just past the selection's corner, as Excel's Auto Fill Options button after a fill. */
  readonly selectionAccessory?: ReactNode;
  /** Drawn under the active cell, as a link's chip is. */
  readonly activeAccessory?: ReactNode;
  /** How conditional formats show cells, by `r|c`. */
  readonly looks?: ReadonlyMap<string, CellLook>;
  /** Rows out of view for now, such as those a filter hides, by ID. */
  readonly hiddenRows?: ReadonlySet<string>;
  /** A filter's header row and columns, which get its buttons; `active` ones have a rule. */
  readonly filterButtons?: {
    readonly row: string;
    readonly cols: readonly string[];
    readonly active: ReadonlySet<string>;
  } | null;
  readonly onFilterButton?: (col: string, button: HTMLElement) => void;
  /** The active cell's list to pick from, as Data Validation gives it; null for none. */
  readonly cellList?: readonly string[] | null;
  readonly onPickFromList?: (value: string) => void;
  /** The selection dragged by its border this far; `copy` when Alt or Ctrl was held. */
  readonly onDragSelection?: (shift: { rows: number; cols: number }, copy: boolean) => void;
}

/** jsdom and a hidden panel measure nothing; a typical panel's size stands in. */
/** Ctrl+; asks for today's date and Ctrl+Shift+; (or Cmd+; on a Mac) for the time, as in Excel. */
const stampOf = (event: KeyboardEvent): "date" | "time" | null => {
  if (event.altKey || (event.key !== ";" && event.key !== ":")) return null;
  if (event.ctrlKey && !event.metaKey) return event.shiftKey ? "time" : "date";
  return event.metaKey && !event.ctrlKey ? "time" : null;
};
/** Today or now as the text a cell reads back as that date or time. */
function stampText(kind: "date" | "time", locale: SheetLocale) {
  const now = new Date();
  if (kind === "time")
    return formatValue((now.getHours() * 60 + now.getMinutes()) / 1440, "h:mm", locale)?.text ?? "";
  const serial = serialOf(now.getFullYear(), now.getMonth() + 1, now.getDate()) ?? 0;
  return formatValue(serial, locale.shortDate, locale)?.text ?? "";
}

const FALLBACK = { width: 960, height: 640 };
const key = (row: number, col: number) => `${row}:${col}`;
const NO_DECORATIONS: readonly GridDecoration[] = [];
const NO_OVERLAYS: readonly GridOverlay[] = [];
const NO_ROWS: ReadonlySet<string> = new Set();
const NO_LOOKS: ReadonlyMap<string, CellLook> = new Map();
const OVERLAY_MIN = { width: 160, height: 120 };

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
  onCommitSelection,
  editSource,
  onCommand,
  onCopy,
  onPaste,
  onResize,
  decorations = NO_DECORATIONS,
  overlays = NO_OVERLAYS,
  selectedOverlay = null,
  onOverlaySelect,
  onOverlayChange,
  onOverlayCommand,
  onFill,
  onDragSelection,
  selectionAccessory,
  activeAccessory,
  looks = NO_LOOKS,
  hiddenRows = NO_ROWS,
  filterButtons = null,
  onFilterButton,
  cellList = null,
  onPickFromList,
}: SheetGridProps) {
  const gridId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, left: 0, ...FALLBACK });
  const data = doc.sheet[sheet]!;
  const rows = useMemo(() => {
    if (!hiddenRows.size) return axisLayout(data.rows, data.rowProps, rowPx);
    // Rows a filter hides measure as hidden ones do, without being stored as hidden.
    const props = { ...data.rowProps };
    for (const id of hiddenRows) props[id] = { ...props[id], hidden: true };
    return axisLayout(data.rows, props, rowPx);
  }, [data.rows, data.rowProps, hiddenRows]);
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
  const editorInput = useRef<HTMLTextAreaElement>(null);
  // Where the caret is in the formula being typed, for completions, hints and pointing.
  const [caret, setCaret] = useState(0);
  // The function the arrow keys have picked among the completions offered.
  const [picked, setPicked] = useState(0);
  /** The reference pointing wrote last, which another click or arrow replaces, and its cells. */
  const [pointing, setPointing] = useState<{
    start: number;
    end: number;
    anchor: { row: number; col: number };
    head: { row: number; col: number };
  } | null>(null);
  // A caret to put back once a rewritten formula is in the input.
  const caretAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    const input = editorInput.current;
    if (input && caretAfter.current !== null) {
      input.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  });
  /** Rewrites the formula being typed and where its caret goes. */
  const rewrite = (text: string, at: number) => {
    if (!editing) return;
    caretAfter.current = at;
    setCaret(at);
    onEditingChange?.({ ...editing, text });
  };
  /** Writes a reference to these cells at the caret, or over the one pointed at before. */
  const point = (from: { row: number; col: number }, headAt: { row: number; col: number }) => {
    if (!editing) return;
    const ref =
      from.row === headAt.row && from.col === headAt.col
        ? corner(from)
        : `${corner({ row: Math.min(from.row, headAt.row), col: Math.min(from.col, headAt.col) })}:${corner({ row: Math.max(from.row, headAt.row), col: Math.max(from.col, headAt.col) })}`;
    const written = insertRef(editing.text, caret, ref, pointing);
    setPointing({ ...written.pointed, anchor: from, head: headAt });
    rewrite(written.text, written.caret);
  };
  /** Whether the edit is pointing at cells rather than moving between them, as Excel's point mode. */
  const pointMode = () => !!editing && (pointing !== null || pointable(editing.text, caret));
  const pointDrag = useRef<{ row: number; col: number } | null>(null);
  const pasteValues = useRef(false);
  /** Ends an edit, writing it, then moves on as Enter or Tab would. */
  const commit = (rowStep: number, colStep: number) => {
    if (!editing || ended.current === editing) return;
    ended.current = editing;
    setPointing(null);
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
    setPointing(null);
    onEditingChange?.(null);
    scroller.current?.focus({ preventScroll: true });
  };
  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const offered = editing ? completionFor(editing.text, caret) : null;
    if (offered && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setPicked(
        (current) => current + (event.key === "ArrowDown" ? 1 : offered.matches.length - 1),
      );
      return;
    }
    if (offered && editing && (event.key === "Tab" || event.key === "Enter")) {
      event.preventDefault();
      const name = offered.matches[picked % offered.matches.length]!;
      const accepted = acceptCompletion(editing.text, caret, offered.start, name);
      setPicked(0);
      rewrite(accepted.text, accepted.caret);
      return;
    }
    // Alt+Enter breaks the line inside the cell; Ctrl+; and Ctrl+Shift+; type today and now.
    const stamp = stampOf(event);
    if (editing && ((event.key === "Enter" && event.altKey) || stamp)) {
      event.preventDefault();
      const input = event.currentTarget;
      const [start, end] = [input.selectionStart ?? caret, input.selectionEnd ?? caret];
      const added = stamp ? stampText(stamp, locale) : "\n";
      rewrite(editing.text.slice(0, start) + added + editing.text.slice(end), start + added.length);
      return;
    }
    if (event.key === "F4" && editing) {
      event.preventDefault();
      const toggled = toggleAbsolute(editing.text, event.currentTarget.selectionStart ?? caret);
      if (toggled) rewrite(toggled.text, toggled.caret);
      return;
    }
    // Arrows in a formula waiting for a reference point at cells, starting from the edited one.
    if (editing?.mode === "type" && arrows[event.key] && pointMode() && !event.shiftKey) {
      event.preventDefault();
      const [down, right] = arrows[event.key]!;
      const from = pointing?.head ?? {
        row: rowIndex.get(editing.at.r) ?? 0,
        col: colIndex.get(editing.at.c) ?? 0,
      };
      const next = {
        row: Math.min(rows.ids.length - 1, Math.max(0, from.row + down)),
        col: Math.min(cols.ids.length - 1, Math.max(0, from.col + right)),
      };
      point(next, next);
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && onCommitSelection && editing) {
      // Ctrl+Enter fills the selection with what was typed, and the selection stays.
      event.preventDefault();
      ended.current = editing;
      setPointing(null);
      onCommitSelection(editing.text);
      onEditingChange!(null);
      scroller.current?.focus({ preventScroll: true });
    } else if (event.key === "Enter") {
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

  const onSheet = (r: number, c: number) =>
    r >= 0 && r < rows.ids.length && c >= 0 && c < cols.ids.length;
  const filledAt = (row: number, col: number) =>
    values.value(sheet, rows.ids[row]!, cols.ids[col]!) !== null;
  /**
   * Where Ctrl+Arrow lands, as in Excel: the end of the run of filled cells it
   * starts in, else the next filled cell, else the sheet's edge.
   */
  const dataEdge = (row: number, col: number, down: number, right: number) => {
    let [r, c] = [row, col];
    if (!onSheet(r + down, c + right)) return [r, c] as const;
    if (filledAt(r, c) && filledAt(r + down, c + right)) {
      while (onSheet(r + down, c + right) && filledAt(r + down, c + right))
        [r, c] = [r + down, c + right];
      return [r, c] as const;
    }
    [r, c] = [r + down, c + right];
    while (onSheet(r + down, c + right) && !filledAt(r, c)) [r, c] = [r + down, c + right];
    return [r, c] as const;
  };
  /** The block of filled cells around a cell, as Ctrl+A first selects: grown while a neighbour holds something. */
  const regionAround = (row: number, col: number) => {
    let [top, bottom, left, right] = [row, row, col, col];
    for (let grew = true; grew;) {
      grew = false;
      const any = (r1: number, r2: number, c1: number, c2: number) => {
        for (let r = Math.max(0, r1); r <= Math.min(rows.ids.length - 1, r2); r++)
          for (let c = Math.max(0, c1); c <= Math.min(cols.ids.length - 1, c2); c++)
            if (filledAt(r, c)) return true;
        return false;
      };
      if (top > 0 && any(top - 1, top - 1, left - 1, right + 1)) [top, grew] = [top - 1, true];
      if (bottom < rows.ids.length - 1 && any(bottom + 1, bottom + 1, left - 1, right + 1))
        [bottom, grew] = [bottom + 1, true];
      if (left > 0 && any(top, bottom, left - 1, left - 1)) [left, grew] = [left - 1, true];
      if (right < cols.ids.length - 1 && any(top, bottom, right + 1, right + 1))
        [right, grew] = [right + 1, true];
    }
    return { top, bottom, left, right };
  };
  /** Selects a rectangle by indexes, the head at its far corner. */
  const selectBox = (from: { row: number; col: number }, to: { row: number; col: number }) =>
    onSelectionChange({
      anchor: { r: rows.ids[from.row]!, c: cols.ids[from.col]! },
      head: { r: rows.ids[to.row]!, c: cols.ids[to.col]! },
    });
  /** The last row and column anything is written in, where Ctrl+End goes. */
  const usedEnd = () => {
    let [row, col] = [0, 0];
    for (const [r, cells] of Object.entries(data.cells)) {
      const at = rowIndex.get(r);
      if (at === undefined) continue;
      for (const c of Object.keys(cells)) {
        const across = colIndex.get(c);
        if (across === undefined) continue;
        row = Math.max(row, at);
        col = Math.max(col, across);
      }
    }
    return [row, col] as const;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!head) return;
    // An open list takes the arrows, Enter and Escape; Alt+Down opens one, as in Excel.
    if (showList && cellList) {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (step || event.key === "Enter" || event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        if (step)
          setListOpen({
            at: listKey,
            picked: Math.min(cellList.length - 1, Math.max(0, listOpen!.picked + step)),
          });
        else if (event.key === "Escape") setListOpen(null);
        else pickFromList(cellList[listOpen!.picked]!);
        return;
      }
    }
    if (event.altKey && event.key === "ArrowDown" && cellList?.length && !readOnly) {
      event.preventDefault();
      setListOpen({ at: listKey, picked: 0 });
      return;
    }
    const command = event.metaKey || event.ctrlKey;
    // Find reads, so it works in a sheet that only reads.
    if (command && !event.altKey && event.key.toLowerCase() === "f" && onCommand) {
      event.preventDefault();
      onCommand({ kind: "find" });
      return;
    }
    // The paste event cannot tell which keys made it, so Cmd+Shift+V is noted for it.
    pasteValues.current = command && event.shiftKey && event.key.toLowerCase() === "v";
    if (writable && command && !event.altKey) {
      const lower = event.key.toLowerCase();
      const found: GridCommand | null =
        lower === "l" && event.shiftKey
          ? { kind: "filter" }
          : lower === "k"
            ? { kind: "link" }
            : lower === "z"
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
                        : lower === "u"
                          ? { kind: "toggle", property: "underline" }
                          : // Ctrl+5 strikes through, as in Excel.
                            event.key === "5"
                            ? { kind: "toggle", property: "strike" }
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
    const lastRow = rows.ids.length - 1;
    const lastCol = cols.ids.length - 1;
    if (command && !event.altKey && event.key.toLowerCase() === "a" && box) {
      // First the block of data around the cell, then, pressed again, the whole sheet.
      event.preventDefault();
      const region = regionAround(head.row, head.col);
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
    if (event.key === " " && box && (event.shiftKey || event.ctrlKey) && !event.metaKey) {
      // Shift+Space selects the selection's rows, Ctrl+Space its columns.
      event.preventDefault();
      if (event.shiftKey && !event.ctrlKey)
        selectBox({ row: box.bottom, col: lastCol }, { row: box.top, col: 0 });
      else if (event.ctrlKey && !event.shiftKey)
        selectBox({ row: lastRow, col: box.right }, { row: 0, col: box.left });
      else selectBox({ row: lastRow, col: lastCol }, { row: 0, col: 0 });
      return;
    }
    const stamp = stampOf(event);
    if (writable && stamp) {
      event.preventDefault();
      beginEdit(stampText(stamp, locale));
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
    const jump = event.metaKey || event.ctrlKey;
    if (move && jump && event.key.startsWith("Arrow")) {
      // From the selection's moving end, so Ctrl+Shift+Arrow keeps extending.
      target = [...dataEdge(head.row, head.col, Math.sign(move[0]), Math.sign(move[1]))];
    } else if (move) {
      // Hidden rows and columns are stepped over, as Excel's arrows do.
      let [row, col] = [head.row + move[0], head.col + move[1]];
      const [down, right] = [Math.sign(move[0]), Math.sign(move[1])];
      if (down || right)
        while (onSheet(row, col) && (!rows.size(row) || !cols.size(col)))
          [row, col] = [row + down, col + right];
      target = onSheet(row, col) ? [row, col] : [head.row, head.col];
    } else if (event.key === "Home") target = [jump ? 0 : head.row, 0];
    else if (event.key === "End" && jump) target = [...usedEnd()];
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
    if (selectedOverlay !== null) onOverlaySelect?.(null);
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
    // A click while a formula waits for a reference writes the cell's, keeping the edit going.
    if (editing && pointMode()) {
      event.preventDefault();
      const anchorAt = event.shiftKey && pointing ? pointing.anchor : at;
      pointDrag.current = anchorAt;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      point(anchorAt, at);
      return;
    }
    if (editing) commit(0, 0);
    // Cmd or Ctrl and a click opens a cell's link, as in Excel.
    if (event.metaKey || event.ctrlKey) {
      const link = safeLink(cellStyle(data.cells[rows.ids[at.row]!]?.[cols.ids[at.col]!]?.s).link);
      if (link) {
        event.preventDefault();
        window.open(link, "_blank", "noopener,noreferrer");
        return;
      }
    }
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    select(at.row, at.col, event.shiftKey);
    scroller.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (event: PointerEvent) => {
    if (pointDrag.current && pointing) {
      const at = cellAt(event);
      if (at.row !== pointing.head.row || at.col !== pointing.head.col)
        point(pointDrag.current, at);
      return;
    }
    if (!dragging.current) return;
    const at = cellAt(event);
    if (head && (at.row !== head.row || at.col !== head.col)) select(at.row, at.col, true);
  };
  const stopDragging = () => {
    dragging.current = false;
    pointDrag.current = null;
  };

  // A header edge dragged: the size follows the pointer, and is reported once let go.
  const [resizing, setResizing] = useState<{
    axis: Axis;
    index: number;
    start: number;
    size: number;
  } | null>(null);
  /**
   * What a double-click on a header's edge sizes it to, as Excel's AutoFit:
   * a column as wide as its widest shown text, a row as tall as its largest
   * font. Null when it holds nothing to fit.
   */
  const autofit = (axis: Axis, index: number): number | null => {
    const id = (axis === "columns" ? cols : rows).ids[index]!;
    let largest = 0;
    for (const [r, row] of Object.entries(data.cells)) {
      if (axis === "rows" && r !== id) continue;
      for (const [c, cell] of Object.entries(row)) {
        if (axis === "columns" && c !== id) continue;
        const style = cellStyle(cell.s);
        const fontPx = style.fontSize ? (style.fontSize * 4) / 3 : 14;
        if (axis === "rows") {
          largest = Math.max(largest, Math.ceil(fontPx * 1.4));
          continue;
        }
        const shown = cellDisplay(values.value(sheet, r, c), style, locale).text;
        if (shown) largest = Math.max(largest, textWidth(shown, fontPx, style.bold) + 10);
      }
    }
    return largest ? Math.ceil(Math.max(axis === "columns" ? 24 : 20, largest)) : null;
  };
  const resizeHandle = (axis: Axis, index: number) =>
    writable && onResize ? (
      <div
        aria-hidden
        className={
          axis === "columns"
            ? "absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize"
            : "absolute -bottom-1 left-0 z-10 h-2 w-full cursor-row-resize"
        }
        onDoubleClick={(event) => {
          event.stopPropagation();
          const size = autofit(axis, index);
          if (size !== null) onResize(axis, (axis === "columns" ? cols : rows).ids[index]!, size);
        }}
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
      const look = looks.get(`${r}|${c}`);
      // Conditional formats show over the cell's own style, as Excel draws them.
      const own = cellStyle(cell?.s);
      const style = look
        ? {
            ...own,
            ...(look.fill ? { fill: look.fill } : {}),
            ...(look.fontColor ? { fontColor: look.fontColor } : {}),
            ...(look.bold ? { bold: true } : {}),
            ...(look.italic ? { italic: true } : {}),
          }
        : own;
      const value = values.value(sheet, r, c);
      const shown = cellDisplay(value, style, locale);
      const bottom = span ? span.bottom : row;
      const right = span ? span.right : col;
      const active = main && head?.row === row && head.col === col;
      const spills = !span && overflowTo > col;
      drawn.add(key(row, col));
      // The empty cells text runs over keep their bottom line, without the lines between them.
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
        <div
          key={key(row, col)}
          id={active ? `${gridId}-active` : undefined}
          role={main ? "gridcell" : undefined}
          aria-rowindex={main ? row + 1 : undefined}
          aria-colindex={main ? col + 1 : undefined}
          aria-selected={active || undefined}
          className={`border-border text-foreground absolute flex border-b px-1 text-sm leading-tight whitespace-pre ${spills ? "overflow-visible" : "overflow-hidden border-r"}`}
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
            // Its fill and borders stay in its own column; only its text runs on, above the spill.
            zIndex: spills ? 2 : span ? 1 : undefined,
            ...cellCss(style),
            ...(shown.color ? { color: shown.color } : {}),
          }}
        >
          {look?.bar ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-xs opacity-60"
              style={{
                width: `calc(${look.bar.fraction * 100}% - 4px)`,
                // The rule's own colour, which is the sheet's data.
                background: `linear-gradient(to right, ${look.bar.color}, color-mix(in oklab, ${look.bar.color} 30%, transparent))`,
              }}
            />
          ) : null}
          <span
            className={
              own.link
                ? `relative underline underline-offset-2${style.fontColor || shown.color ? "" : " text-primary"}`
                : "relative"
            }
          >
            {shown.text}
          </span>
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
          // Only as far as the text needs: text that fits keeps its cell's borders.
          const needed =
            textWidth(value, style.fontSize ? (style.fontSize * 4) / 3 : 14, style.bold) + 8;
          while (
            cols.starts[overflowTo + 1]! - cols.starts[col]! < needed &&
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
    // A filter's buttons, at the right of its header cells, as Excel draws them.
    if (filterButtons) {
      const row = rowIndex.get(filterButtons.row);
      if (row !== undefined && row >= rowRange.first && row <= rowRange.last)
        for (const c of filterButtons.cols) {
          const col = colIndex.get(c);
          if (col === undefined || col < colRange.first || col > colRange.last || !cols.size(col))
            continue;
          const active = filterButtons.active.has(c);
          cells.push(
            <button
              key={`filter-${c}`}
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
            </button>,
          );
        }
    }
    return cells;
  };
  const cells = paneCells(visibleRows, visibleCols, true);

  /**
   * A header pressed: its whole column (or row) selected, Shift extending
   * from the selection's anchor, and a drag along the headers taking more.
   */
  const startHeaderSelect = (event: PointerEvent, axis: Axis, index: number) => {
    if (event.button !== 0 || !rows.ids.length || !cols.ids.length) return;
    event.preventDefault();
    if (editing) commit(0, 0);
    if (selectedOverlay !== null) onOverlaySelect?.(null);
    const columns = axis === "columns";
    const anchorIndex = event.shiftKey && anchor ? (columns ? anchor.col : anchor.row) : index;
    const span = (to: number) =>
      // The active cell stays at the top (or left), so the sheet does not scroll to the end.
      columns
        ? selectBox({ row: rows.ids.length - 1, col: anchorIndex }, { row: 0, col: to })
        : selectBox({ row: anchorIndex, col: cols.ids.length - 1 }, { row: to, col: 0 });
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
    const inSelection = box && col >= box.left && col <= box.right;
    // A hidden column has no header; its neighbours meet where it was.
    if (!cols.size(col)) return null;
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
        onPointerDown={(event) => startHeaderSelect(event, "columns", col)}
      >
        {columnLetters(col + 1)}
        {resizeHandle("columns", col)}
      </div>
    );
  };
  /** A row's header; `offset` places it in the corner, below the column headers. */
  const rowHeader = (row: number, offset = 0) => {
    const inSelection = box && row >= box.top && row <= box.bottom;
    if (!rows.size(row)) return null;
    return (
      <div
        key={row}
        role="rowheader"
        className={`border-border text-muted-foreground absolute left-0 flex items-center justify-center border-r border-b text-xs ${inSelection ? "bg-accent text-accent-foreground" : "bg-muted"}`}
        style={{ top: offset + rows.starts[row]!, height: rows.size(row), width: HEADER_COLUMN_PX }}
        onPointerDown={(event) => startHeaderSelect(event, "rows", row)}
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

  const [filling, setFilling] = useState<{
    direction: GridFill["direction"];
    count: number;
  } | null>(null);
  /** Drags the fill handle: the cell under the pointer, past whichever edge it is furthest beyond. */
  const startFill = (event: PointerEvent) => {
    if (event.button !== 0 || !box) return;
    event.stopPropagation();
    event.preventDefault();
    const from = box;
    let current: { direction: GridFill["direction"]; count: number } | null = null;
    const move = (next: globalThis.PointerEvent) => {
      const rect = content.current?.getBoundingClientRect();
      if (!rect) return;
      const row = rows.indexAt(next.clientY - rect.top);
      const col = cols.indexAt(next.clientX - rect.left);
      const reaches = [
        ["down", row - from.bottom],
        ["up", from.top - row],
        ["right", col - from.right],
        ["left", from.left - col],
      ] as const;
      const [direction, count] = reaches.reduce((best, each) => (each[1] > best[1] ? each : best));
      // Back inside the selection, the handle marks its last rows or columns to clear.
      const inside = row >= from.top && row <= from.bottom && col >= from.left && col <= from.right;
      const shrink =
        from.bottom - row >= from.right - col
          ? { direction: "down" as const, count: row - from.bottom }
          : { direction: "right" as const, count: col - from.right };
      current = count > 0 ? { direction, count } : inside && shrink.count < 0 ? shrink : null;
      setFilling(current);
    };
    const end = (last: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setFilling(null);
      if (current && last.type === "pointerup")
        onFill?.({ ...current, mode: last.ctrlKey || last.altKey ? "alternate" : "auto" });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  // The active cell's list, open below it; the picked choice moves with the arrow keys.
  const [listOpen, setListOpen] = useState<{ at: string; picked: number } | null>(null);
  const listKey = selection ? `${selection.head.r}|${selection.head.c}` : "";
  const showList = listOpen?.at === listKey && !!cellList?.length && !readOnly;
  const pickFromList = (value: string) => {
    setListOpen(null);
    onPickFromList?.(value);
    scroller.current?.focus({ preventScroll: true });
  };
  const cellListUi =
    head && cellList?.length && !readOnly && !editing ? (
      <>
        <button
          type="button"
          aria-label="Choose from list"
          aria-expanded={showList}
          tabIndex={-1}
          className="border-border bg-background text-muted-foreground absolute z-20 flex items-center justify-center rounded-sm border"
          style={{
            top: rows.starts[head.row]! + 1,
            left: cols.starts[head.col + 1]! + 1,
            width: 16,
            height: rows.size(head.row) - 2,
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            setListOpen(showList ? null : { at: listKey, picked: 0 });
          }}
        >
          <svg aria-hidden viewBox="0 0 10 10" className="size-2.5" fill="currentColor">
            <path d="M2 3.5h6L5 7z" />
          </svg>
        </button>
        {showList ? (
          <ul
            role="listbox"
            aria-label="Choices"
            className="bg-popover text-popover-foreground border-border absolute z-50 max-h-60 min-w-32 overflow-y-auto rounded-md border py-1 text-sm shadow-md"
            style={{
              top: rows.starts[head.row + 1]! + 2,
              left: cols.starts[head.col]!,
              width: Math.max(cols.size(head.col), 128),
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {cellList.map((choice, index) => (
              <li
                key={choice}
                role="option"
                aria-selected={index === listOpen!.picked}
                className="aria-selected:bg-accent aria-selected:text-accent-foreground cursor-pointer truncate px-2 py-0.5"
                onPointerDown={(event) => {
                  event.preventDefault();
                  pickFromList(choice);
                }}
              >
                {choice}
              </li>
            ))}
          </ul>
        ) : null}
      </>
    ) : null;
  const fillHandle =
    box && onFill && !readOnly && !editing ? (
      <div
        role="button"
        aria-label="Fill"
        tabIndex={-1}
        data-fill-handle=""
        className="border-background bg-primary absolute z-20 size-2 cursor-crosshair border"
        style={{
          top: rows.starts[box.bottom + 1]! - 4,
          left: cols.starts[box.right + 1]! - 4,
        }}
        onPointerDown={startFill}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onFill({ direction: "down", count: "auto", mode: "auto" });
        }}
      />
    ) : null;
  // The cells a fill handle drag would write, outlined while it is dragged.
  const fillPreview =
    box && filling
      ? (() => {
          const [top, bottom, left, right] =
            filling.count < 0
              ? filling.direction === "down"
                ? [box.bottom + filling.count + 1, box.bottom, box.left, box.right]
                : [box.top, box.bottom, box.right + filling.count + 1, box.right]
              : filling.direction === "down"
                ? [box.bottom + 1, box.bottom + filling.count, box.left, box.right]
                : filling.direction === "up"
                  ? [box.top - filling.count, box.top - 1, box.left, box.right]
                  : filling.direction === "right"
                    ? [box.top, box.bottom, box.right + 1, box.right + filling.count]
                    : [box.top, box.bottom, box.left - filling.count, box.left - 1];
          const [t, b] = [Math.max(0, top), Math.min(rows.ids.length - 1, bottom)];
          const [l, r] = [Math.max(0, left), Math.min(cols.ids.length - 1, right)];
          return (
            <div
              aria-hidden
              className={`border-primary pointer-events-none absolute z-10 border-2 border-dashed ${filling.count < 0 ? "bg-muted/70" : ""}`}
              style={{
                top: rows.starts[t],
                left: cols.starts[l],
                height: rows.starts[b + 1]! - rows.starts[t]!,
                width: cols.starts[r + 1]! - cols.starts[l]!,
              }}
            />
          );
        })()
      : null;

  const [shifting, setShifting] = useState<{ rows: number; cols: number } | null>(null);
  /** The cell under a point on the page, by the main pane's coordinates. */
  const cellUnder = (at: { clientX: number; clientY: number }) => {
    const rect = content.current!.getBoundingClientRect();
    return { row: rows.indexAt(at.clientY - rect.top), col: cols.indexAt(at.clientX - rect.left) };
  };
  /** Drags the selection by its border, a whole number of cells at a time. */
  const startShift = (event: PointerEvent) => {
    if (event.button !== 0 || !box) return;
    event.stopPropagation();
    event.preventDefault();
    const from = cellUnder(event);
    const limits = { up: -box.top, left: -box.left };
    let current: { rows: number; cols: number } | null = null;
    const move = (next: globalThis.PointerEvent) => {
      const at = cellUnder(next);
      current = {
        rows: Math.max(limits.up, at.row - from.row),
        cols: Math.max(limits.left, at.col - from.col),
      };
      setShifting(current.rows || current.cols ? current : null);
    };
    const end = (last: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setShifting(null);
      if (current && (current.rows || current.cols) && last.type === "pointerup")
        onDragSelection?.(current, last.altKey || last.ctrlKey || last.metaKey);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  // Thin strips on the selection's border that pick it up; the cells inside keep their clicks.
  const moveEdges =
    box && onDragSelection && !readOnly && !editing
      ? (() => {
          const [top, left] = [rows.starts[box.top]!, cols.starts[box.left]!];
          const [bottom, right] = [rows.starts[box.bottom + 1]!, cols.starts[box.right + 1]!];
          const edges = [
            { key: "top", top: top - 3, left, width: right - left, height: 5 },
            { key: "bottom", top: bottom - 2, left, width: right - left - 6, height: 5 },
            { key: "left", top, left: left - 3, width: 5, height: bottom - top },
            { key: "right", top, left: right - 2, width: 5, height: bottom - top - 6 },
          ];
          return edges.map(({ key: edge, ...place }) => (
            <div
              key={edge}
              aria-hidden
              data-move-edge={edge}
              className="absolute z-20 cursor-move"
              style={place}
              onPointerDown={startShift}
            />
          ));
        })()
      : null;
  const shiftPreview =
    box && shifting ? (
      <div
        aria-hidden
        className="border-primary pointer-events-none absolute z-10 border-2 border-dashed"
        style={{
          top: rows.starts[Math.min(rows.ids.length - 1, box.top + shifting.rows)],
          left: cols.starts[Math.min(cols.ids.length - 1, box.left + shifting.cols)],
          height: rows.starts[box.bottom + 1]! - rows.starts[box.top]!,
          width: cols.starts[box.right + 1]! - cols.starts[box.left]!,
        }}
      />
    ) : null;

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
    if (rect && decoration.marker)
      return [
        <div
          key={decoration.key}
          aria-hidden
          className="pointer-events-none absolute z-10 size-0 border-t-[7px] border-l-[7px] border-l-transparent"
          style={{
            top: rect.top + 1,
            left: rect.left + rect.width - 8,
            borderTopColor: decoration.color,
          }}
        />,
      ];
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
      <textarea
        ref={editorInput}
        rows={1}
        spellCheck={false}
        aria-label="Cell content"
        autoFocus
        value={editing.text}
        onChange={(event) => {
          // Typing ends pointing: the next reference is written at the caret.
          setPointing(null);
          setPicked(0);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          onEditingChange?.({ ...editing, text: event.target.value });
        }}
        onSelect={(event) => {
          // A select reported before a rewritten formula reaches the input has the old caret.
          if (caretAfter.current === null) setCaret(event.currentTarget.selectionStart ?? 0);
        }}
        onKeyDown={onEditorKeyDown}
        onBlur={(event) => {
          // Focus moving to the formula bar keeps the edit going there.
          if (
            !(event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.sheetEditor)
          )
            commit(0, 0);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className="bg-background text-foreground border-primary absolute z-40 resize-none overflow-hidden border-2 px-1 text-sm leading-4 whitespace-pre outline-none"
        style={{
          ...editorRect,
          // A text with line breaks grows the editor by a line each, as Excel's does.
          width: Math.max(
            editorRect.width,
            (Math.max(...editing.text.split("\n").map((line) => line.length)) + 2) * 8,
          ),
          height: Math.max(editorRect.height, editing.text.split("\n").length * 16 + 4),
        }}
      />
    ) : null;
  const formulaPopup =
    editing && editorRect && editing.text.startsWith("=") ? (
      <FormulaPopup
        text={editing.text}
        caret={caret}
        picked={picked}
        onPick={(name) => {
          const offered = completionFor(editing.text, caret);
          if (!offered) return;
          const accepted = acceptCompletion(editing.text, caret, offered.start, name);
          setPicked(0);
          rewrite(accepted.text, accepted.caret);
        }}
        style={{ top: editorRect.top + editorRect.height + 2, left: editorRect.left }}
      />
    ) : null;
  // The cells each reference of a formula being typed reads, outlined in its colour.
  const sheetName = data.name.toLowerCase();
  const refOutlines = editing?.text.startsWith("=")
    ? formulaRefs(editing.text).flatMap((ref, index) => {
        if (ref.sheet !== null && ref.sheet.toLowerCase() !== sheetName) return [];
        const [top, bottom] =
          ref.top === null ? [0, rows.ids.length - 1] : [ref.top - 1, ref.bottom! - 1];
        const [left, right] =
          ref.left === null ? [0, cols.ids.length - 1] : [ref.left - 1, ref.right! - 1];
        if (bottom >= rows.ids.length || right >= cols.ids.length) return [];
        const color = REF_COLORS[index % REF_COLORS.length]!;
        return [
          <div
            key={`ref-${ref.start}`}
            aria-hidden
            className="pointer-events-none absolute z-10 border-2"
            style={{
              top: rows.starts[top],
              left: cols.starts[left],
              height: rows.starts[bottom + 1]! - rows.starts[top]!,
              width: cols.starts[right + 1]! - cols.starts[left]!,
              borderColor: color,
              backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
            }}
          />,
        ];
      })
    : null;

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
      {editingPane === name ? formulaPopup : null}
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
        if (event.target instanceof HTMLTextAreaElement) return;
        beginEdit(null);
      }}
      onCopy={(event) => {
        if (editing || !onCopy) return;
        const copied = onCopy(false);
        if (copied === null) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", copied.text);
        if (copied.html) event.clipboardData.setData("text/html", copied.html);
      }}
      onCut={(event) => {
        if (editing || !onCopy || !writable) return;
        const copied = onCopy(true);
        if (copied === null) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", copied.text);
        if (copied.html) event.clipboardData.setData("text/html", copied.html);
      }}
      onPaste={(event) => {
        if (editing || !onPaste || !writable) return;
        event.preventDefault();
        const valuesOnly = pasteValues.current;
        pasteValues.current = false;
        onPaste({
          text: event.clipboardData.getData("text/plain"),
          html: event.clipboardData.getData("text/html") || null,
          values: valuesOnly,
        });
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
              role="button"
              aria-label="Select all"
              className="border-border bg-muted absolute top-0 left-0 border-r border-b"
              style={{ width: HEADER_COLUMN_PX, height: HEADER_ROW_PX }}
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
          data-sheet-content=""
          // Its own stacking layer, so charts and the editor stay under the headers and frozen panes.
          className="absolute isolate"
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
          {fillPreview}
          {shiftPreview}
          {moveEdges}
          {fillHandle}
          {cellListUi}
          {head && activeAccessory && !editing ? (
            <div
              className="absolute z-20"
              style={{ top: rows.starts[head.row + 1]! + 4, left: cols.starts[head.col] }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {activeAccessory}
            </div>
          ) : null}
          {box && selectionAccessory && !editing ? (
            <div
              className="absolute z-20"
              style={{
                top: rows.starts[box.bottom + 1]! + 4,
                left: cols.starts[box.right + 1]! + 4,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {selectionAccessory}
            </div>
          ) : null}
          {overlays.flatMap((overlay) => {
            const row = rowIndex.get(overlay.at.r);
            const col = colIndex.get(overlay.at.c);
            if (row === undefined || col === undefined) return [];
            const editable = !readOnly && onOverlayChange !== undefined;
            // The cell under a point becomes the overlay's new anchor, as a chart moves with it.
            const placeAt = (rowAt: number, colAt: number, width: number, height: number) =>
              onOverlayChange?.(overlay.key, {
                at: { r: rows.ids[rowAt]!, c: cols.ids[colAt]! },
                width,
                height,
              });
            return [
              <OverlayFrame
                key={overlay.key}
                label={overlay.label}
                place={{
                  top: rows.starts[row]!,
                  left: cols.starts[col]!,
                  width: overlay.width,
                  height: overlay.height,
                }}
                selected={selectedOverlay === overlay.key}
                editable={editable}
                min={overlay.min ?? OVERLAY_MIN}
                onSelect={() => onOverlaySelect?.(overlay.key)}
                onDeselect={() => {
                  onOverlaySelect?.(null);
                  scroller.current?.focus({ preventScroll: true });
                }}
                onPlace={(place) =>
                  placeAt(
                    rows.indexAt(Math.max(0, place.top)),
                    cols.indexAt(Math.max(0, place.left)),
                    place.width,
                    place.height,
                  )
                }
                onNudge={(down, right) =>
                  placeAt(
                    Math.min(rows.ids.length - 1, Math.max(0, row + down)),
                    Math.min(cols.ids.length - 1, Math.max(0, col + right)),
                    overlay.width,
                    overlay.height,
                  )
                }
                onCommand={(command) => {
                  onOverlayCommand?.(overlay.key, command);
                  if (command === "delete") scroller.current?.focus({ preventScroll: true });
                }}
              >
                {overlay.content}
              </OverlayFrame>,
            ];
          })}
          {refOutlines}
          {editingPane === "main" ? editor : null}
          {editingPane === "main" ? formulaPopup : null}
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
