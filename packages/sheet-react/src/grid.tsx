import { cellStyle } from "@chat/sheet/model/style";
import {
  useCallback,
  useEffect,
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
import type { SheetLocale } from "@chat/sheet/locales";
import type { SheetValues } from "@chat/sheet/model/calc";
import type { Axis, SheetDoc } from "@chat/sheet/model";
import type { CellLook } from "@chat/sheet/model/conditional";
import { collapsedOf, outlineDepth, placeGroups } from "@chat/sheet/model/outline";
import { cellDisplay, safeLink } from "./display.ts";
import {
  HEADER_COLUMN_PX,
  HEADER_ROW_PX,
  OUTLINE_STEP,
  drawnLayout,
  columnPx,
  rowPx,
  visibleRange,
} from "./layout.ts";
import type { OverlayCommand } from "./overlay-place.ts";
import { OutlineLevels, OutlineMarks } from "./grid-outline.tsx";
import { drawPane, type PaneDrawing } from "./grid-cells.tsx";
import {
  adding,
  autofit,
  dataEdge,
  mergeIndex,
  onSheet,
  regionAround,
  usedEnd,
  type FilledCells,
} from "./grid-navigation.ts";
import { commandShortcut, ctrlShortcut, stampOf, stampText } from "./grid-keys.ts";
import type {
  GridCommand,
  GridDecoration,
  GridOverlay,
  OnOutline,
  OverlayChange,
} from "./grid-types.ts";
import { CellEditor, RefOutlines } from "./cell-editor.tsx";
import { useCellEdit } from "./use-cell-edit.ts";
import { FillHandle, MoveEdges } from "./grid-drags.tsx";
import { GridOverlays } from "./grid-overlays.tsx";

export type { OverlayCommand } from "./overlay-place.ts";
export type { GridCommand, GridDecoration, GridOverlay, OverlayChange } from "./grid-types.ts";
export type { CellEditing, CellRef, GridFill, SheetSelection } from "./selection.ts";
import type { CellEditing, CellRef, GridFill, SheetSelection } from "./selection.ts";

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
  /** A paste: the clipboard's text, HTML and any picture, and whether Cmd+Shift+V asked for values only. */
  readonly onPaste?: (clip: {
    text: string;
    html: string | null;
    image: File | null;
    values: boolean;
  }) => void;
  /** A row or column dragged to a new size, in pixels. */
  readonly onResize?: (axis: Axis, id: string, px: number) => void;
  readonly decorations?: readonly GridDecoration[];
  /**
   * A box laid invisibly over some cells, for something outside the grid to
   * sit beside (a comment card): the grid places it, as it scrolls and zooms.
   */
  readonly beside?: {
    readonly cells: SheetSelection;
    readonly onElement: (element: HTMLElement | null) => void;
  } | null;
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
  /** Collapsing or expanding a group, or showing an outline level; without it, no buttons show. */
  readonly onOutline?: OnOutline;
  /**
   * How large the cells draw, 1 as stored. Only this view scales: sizes it
   * reports back, from a resize or a moved chart, are unscaled.
   */
  readonly zoom?: number;
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

/** The invisible box something outside the grid sits beside, handed out as it mounts. */
function BesideBox({
  rect,
  onElement,
}: {
  rect: { top: number; left: number; width: number; height: number };
  onElement: (element: HTMLElement | null) => void;
}) {
  return <div ref={onElement} aria-hidden className="pointer-events-none absolute" style={rect} />;
}

/** Whether two sets hold the same members. */
const sameMembers = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((member) => b.has(member));

/** jsdom and a hidden panel measure nothing; a typical panel's size stands in. */
const FALLBACK = { width: 960, height: 640 };
/** How far a reveal may scroll and still glide there. */
const GLIDE_PX = 240;
const NO_DECORATIONS: readonly GridDecoration[] = [];
const NO_OVERLAYS: readonly GridOverlay[] = [];
const NO_ROWS: ReadonlySet<string> = new Set();
const NO_LOOKS: ReadonlyMap<string, CellLook> = new Map();

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
  beside = null,
  overlays = NO_OVERLAYS,
  selectedOverlay = null,
  onOverlaySelect,
  onOverlayChange,
  onOverlayCommand,
  onFill,
  onDragSelection,
  selectionAccessory,
  activeAccessory,
  onOutline,
  zoom = 1,
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
  const rowGroups = useMemo(
    () => placeGroups(data.rows, data.outline?.rows),
    [data.rows, data.outline?.rows],
  );
  const colGroups = useMemo(
    () => placeGroups(data.cols, data.outline?.cols),
    [data.cols, data.outline?.cols],
  );
  // A filter's hidden rows come as a new set whenever values change; the layout is rebuilt
  // only when the rows in it do.
  const [steadyHidden, setSteadyHidden] = useState(hiddenRows);
  if (steadyHidden !== hiddenRows && !sameMembers(steadyHidden, hiddenRows))
    setSteadyHidden(hiddenRows);
  const rows = useMemo(
    () =>
      drawnLayout(
        data.rows,
        data.rowProps,
        [...steadyHidden, ...collapsedOf(data.rows, rowGroups)],
        (props) => rowPx(props) * zoom,
      ),
    [data.rows, data.rowProps, steadyHidden, rowGroups, zoom],
  );
  const cols = useMemo(
    () =>
      drawnLayout(
        data.cols,
        data.colProps,
        collapsedOf(data.cols, colGroups),
        (props) => columnPx(props) * zoom,
      ),
    [data.cols, data.colProps, colGroups, zoom],
  );
  // The outline gutters beside and above the headers: a step per level, and one for the buttons.
  const rowGutter = rowGroups.length ? (outlineDepth(rowGroups) + 1) * OUTLINE_STEP : 0;
  const colGutter = colGroups.length ? (outlineDepth(colGroups) + 1) * OUTLINE_STEP : 0;
  const headerWidth = HEADER_COLUMN_PX + rowGutter;
  const headerHeight = HEADER_ROW_PX + colGutter;
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
  const filled: FilledCells = {
    rows: rows.ids.length,
    cols: cols.ids.length,
    at: (row, col) => values.value(sheet, rows.ids[row]!, cols.ids[col]!) !== null,
  };
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
      // Extending keeps the other ranges; anything else starts over with one.
      onSelectionChange({
        anchor: extend && selection ? selection.anchor : at,
        head: at,
        ...(extend && selection?.more ? { more: selection.more } : {}),
      });
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
      let [y, x] = [element.scrollTop, element.scrollLeft];
      if (row >= frozenRows) {
        if (top - frozenHeight < y) y = top - frozenHeight;
        else if (bottom + headerHeight > y + height) y = bottom + headerHeight - height;
      }
      if (col >= frozenCols) {
        if (left - frozenWidth < x) x = left - frozenWidth;
        else if (right + headerWidth > x + width) x = right + headerWidth - width;
      }
      if (y === element.scrollTop && x === element.scrollLeft) return;
      // A step of a few cells glides, as Excel's does; a long jump (to the data's end, a find)
      // lands at once rather than sweeping past everything between.
      const near = Math.abs(y - element.scrollTop) + Math.abs(x - element.scrollLeft) <= GLIDE_PX;
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
      if (near && !still && typeof element.scrollTo === "function")
        element.scrollTo({ top: y, left: x, behavior: "smooth" });
      else {
        element.scrollTop = y;
        element.scrollLeft = x;
      }
    },
    [
      cols.starts,
      rows.starts,
      frozenRows,
      frozenCols,
      frozenHeight,
      frozenWidth,
      headerHeight,
      headerWidth,
    ],
  );

  // A selection set from outside, as a find does, is scrolled into view like one moved by key.
  // Only its moving does: any redraw rebuilds reveal, and one while the reader has scrolled
  // away (to drag a chart) must not pull them back.
  const headRow = head?.row;
  const headCol = head?.col;
  const revealHead = useEffectEvent((row: number, col: number) => reveal(row, col));
  useEffect(() => {
    if (headRow !== undefined && headCol !== undefined) revealHead(headRow, headCol);
  }, [headRow, headCol]);

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
  const focusGrid = () => scroller.current?.focus({ preventScroll: true });
  const edit = useCellEdit({
    editing,
    onEditingChange,
    onCommit,
    onCommitSelection,
    locale,
    rows,
    cols,
    rowIndex,
    colIndex,
    select,
    reveal,
    focusGrid,
  });
  const { pointing, point, pointMode, commit } = edit;
  const pointDrag = useRef<{ row: number; col: number } | null>(null);
  const pasteValues = useRef(false);
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
    // Print, the sheet rather than the page around it.
    if (command && !event.altKey && event.key.toLowerCase() === "p" && onCommand) {
      event.preventDefault();
      onCommand({ kind: "print" });
      return;
    }
    // Ctrl+PageUp and PageDown move between sheets; Shift+F11 adds one.
    if (
      onCommand &&
      command &&
      !event.shiftKey &&
      (event.key === "PageUp" || event.key === "PageDown")
    ) {
      event.preventDefault();
      onCommand({ kind: "sheet", step: event.key === "PageUp" ? -1 : 1 });
      return;
    }
    if (writable && event.shiftKey && event.key === "F11") {
      event.preventDefault();
      onCommand?.({ kind: "newSheet" });
      return;
    }
    if (onCommand && event.shiftKey && !command && event.key === "F2") {
      event.preventDefault();
      onCommand({ kind: "comment" });
      return;
    }
    // Ctrl+Backspace brings the active cell back into view.
    if (command && event.key === "Backspace") {
      event.preventDefault();
      reveal(head.row, head.col);
      return;
    }
    // The paste event cannot tell which keys made it, so Cmd+Shift+V is noted for it.
    pasteValues.current = command && event.shiftKey && event.key.toLowerCase() === "v";
    if (writable && command && !event.altKey) {
      const more =
        commandShortcut(event) ?? ctrlShortcut(event, box, rows.ids.length, cols.ids.length);
      if (more) {
        event.preventDefault();
        onCommand?.(more);
        return;
      }
      // Ctrl+' copies the formula above as typed, Ctrl+Shift+" the value it shows.
      if ((event.key === "'" || event.key === '"') && head.row > 0) {
        event.preventDefault();
        const above = { r: rows.ids[head.row - 1]!, c: cols.ids[head.col]! };
        beginEdit(
          event.key === "'"
            ? (editSource?.(above) ?? "")
            : cellDisplay(values.value(sheet, above.r, above.c), {}, locale).text,
        );
        return;
      }
    }
    // Alt+= sums, as Excel's AutoSum.
    if (writable && event.altKey && !command && event.code === "Equal") {
      event.preventDefault();
      onCommand?.({ kind: "autosum" });
      return;
    }
    // Over a range, Backspace clears every cell as Delete does, Excel for Mac's delete key.
    const range =
      !!box && (box.top !== box.bottom || box.left !== box.right || !!selection?.more?.length);
    if (writable && (event.key === "Delete" || (event.key === "Backspace" && range))) {
      event.preventDefault();
      onCommand?.({ kind: "clear" });
      return;
    }
    // Backspace empties the cell to type afresh, as Excel's does; Escape keeps what was there.
    if (writable && event.key === "Backspace") {
      event.preventDefault();
      beginEdit("");
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
    // Group and Ungroup, as Excel's Alt+Shift+arrows.
    if (
      writable &&
      event.altKey &&
      event.shiftKey &&
      !command &&
      (event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      onCommand?.({ kind: event.key === "ArrowRight" ? "group" : "ungroup" });
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
    const jump = event.metaKey || event.ctrlKey;
    if (move && jump && event.key.startsWith("Arrow")) {
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
    } else if (event.key === "Home") target = [jump ? 0 : head.row, 0];
    else if (event.key === "End" && jump) target = [...usedEnd(data.cells, rowIndex, colIndex)];
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
    if ((event.metaKey || event.ctrlKey) && selection && !event.shiftKey)
      onSelectionChange(adding(selection, { r: rows.ids[at.row]!, c: cols.ids[at.col]! }));
    else select(at.row, at.col, event.shiftKey);
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
          const size = autofit(
            { cells: data.cells, values, sheet, locale },
            axis,
            (axis === "columns" ? cols : rows).ids[index]!,
          );
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
          onResize(resizing.axis, layout.ids[resizing.index]!, Math.round(resizing.size / zoom));
          setResizing(null);
        }}
      />
    ) : null;

  const visibleRows = visibleRange(rows, viewport.top, viewport.height);
  const visibleCols = visibleRange(cols, viewport.left, viewport.width);
  const drawing: PaneDrawing = {
    gridId,
    sheet,
    cells: data.cells,
    values,
    locale,
    looks,
    rows,
    cols,
    rowIndex,
    colIndex,
    merges,
    head,
    zoom,
    filterButtons,
    onFilterButton,
  };
  const paneCells = (
    rowRange: { first: number; last: number },
    colRange: { first: number; last: number },
    main: boolean,
  ) => drawPane(drawing, rowRange, colRange, main);
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
    // Cmd or Ctrl adds the rows or columns to what is selected; Shift extends the active range.
    const kept =
      (event.metaKey || event.ctrlKey) && selection
        ? adding(selection, selection.head).more
        : event.shiftKey
          ? selection?.more
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
    const inSelection = box && col >= box.left && col <= box.right;
    // A hidden column has no header; its neighbours meet where it was.
    if (!cols.size(col)) return null;
    return (
      <div
        key={col}
        role="columnheader"
        className={`border-border text-muted-foreground absolute flex items-center justify-center border-r border-b text-xs ${inSelection ? "bg-accent text-accent-foreground" : "bg-muted"}`}
        style={{
          top: colGutter,
          left: headerWidth + cols.starts[col]!,
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
        className={`border-border text-muted-foreground absolute flex items-center justify-center border-r border-b text-xs ${inSelection ? "bg-accent text-accent-foreground" : "bg-muted"}`}
        style={{
          top: offset + rows.starts[row]!,
          left: rowGutter,
          height: rows.size(row),
          width: HEADER_COLUMN_PX,
        }}
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

  // The other selected ranges, shaded as Excel shades them, without the active range's frame.
  const moreBoxes = (selection?.more ?? []).flatMap((range) => {
    const [a, b] = [
      { row: rowIndex.get(range.anchor.r), col: colIndex.get(range.anchor.c) },
      { row: rowIndex.get(range.head.r), col: colIndex.get(range.head.c) },
    ];
    if (a.row === undefined || a.col === undefined || b.row === undefined || b.col === undefined)
      return [];
    const [top, bottom] = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
    const [left, right] = [Math.min(a.col, b.col), Math.max(a.col, b.col)];
    return [
      <div
        key={`${range.anchor.r}:${range.anchor.c}:${range.head.r}:${range.head.c}`}
        aria-hidden
        className="border-primary/60 bg-primary/10 pointer-events-none absolute z-10 border"
        style={{
          top: rows.starts[top],
          left: cols.starts[left],
          height: rows.starts[bottom + 1]! - rows.starts[top]!,
          width: cols.starts[right + 1]! - cols.starts[left]!,
        }}
      />,
    ];
  });
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
  const besideRect = beside ? rectOf(beside.cells) : null;
  const anchorBox =
    beside && besideRect ? <BesideBox rect={besideRect} onElement={beside.onElement} /> : null;
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
                className="absolute -top-4 left-0 rounded-sm px-1 text-[10px] leading-4 whitespace-nowrap text-chart-foreground"
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
      <CellEditor
        editing={editing}
        rect={editorRect}
        zoom={zoom}
        edit={edit}
        onEditingChange={onEditingChange}
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
      // Its own stacking layer: outlines inside stay under the headers, as in the content.
      className="bg-background absolute isolate overflow-hidden"
      style={{
        top: name === "left" ? 0 : headerHeight,
        left: headerWidth,
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
      {moreBoxes}
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
          image:
            [...(event.clipboardData.files ?? [])].find((file) => file.type.startsWith("image/")) ??
            null,
          values: valuesOnly,
        });
      }}
      className="bg-background focus-visible:ring-ring relative h-full w-full overflow-auto outline-none focus-visible:ring-2"
    >
      <div
        className="relative"
        style={{ width: headerWidth + cols.total, height: headerHeight + rows.total }}
      >
        <div className="sticky top-0 z-30" style={{ height: headerHeight + frozenHeight }}>
          <div
            className="sticky left-0 z-10"
            style={{ width: headerWidth + frozenWidth, height: headerHeight + frozenHeight }}
          >
            <div
              role="button"
              aria-label="Select all"
              className="border-border bg-muted absolute border-r border-b"
              style={{
                top: colGutter,
                left: rowGutter,
                width: HEADER_COLUMN_PX,
                height: HEADER_ROW_PX,
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || !rows.ids.length || !cols.ids.length) return;
                event.preventDefault();
                selectBox(
                  { row: rows.ids.length - 1, col: cols.ids.length - 1 },
                  { row: 0, col: 0 },
                );
              }}
            />
            {onOutline ? (
              <OutlineLevels
                rowDepth={rowGutter ? outlineDepth(rowGroups) : 0}
                colDepth={colGutter ? outlineDepth(colGroups) : 0}
                rowGutter={rowGutter}
                colGutter={colGutter}
                onOutline={onOutline}
              />
            ) : null}
            {Array.from({ length: frozenCols }, (_, col) => columnHeader(col))}
            {Array.from({ length: frozenRows }, (_, row) => rowHeader(row, headerHeight))}
            {frozenRows && frozenCols
              ? pane(
                  "corner",
                  { first: 0, last: frozenRows - 1 },
                  { first: 0, last: frozenCols - 1 },
                )
              : null}
          </div>
          <OutlineMarks
            axis="columns"
            groups={colGroups}
            layout={cols}
            offset={headerWidth}
            onOutline={onOutline}
          />
          {columnHeaders}
          {frozenRows ? pane("top", { first: 0, last: frozenRows - 1 }, visibleCols) : null}
        </div>
        <div
          className="sticky left-0 z-20"
          style={{
            width: headerWidth + frozenWidth,
            height: rows.total,
            marginTop: -frozenHeight,
          }}
        >
          <OutlineMarks
            axis="rows"
            groups={rowGroups}
            layout={rows}
            offset={0}
            onOutline={onOutline}
          />
          {rowHeaders}
          {frozenCols ? pane("left", visibleRows, { first: 0, last: frozenCols - 1 }) : null}
        </div>
        <div
          ref={content}
          data-sheet-content=""
          // Its own stacking layer, so charts and the editor stay under the headers and frozen panes.
          className="absolute isolate"
          style={{
            top: headerHeight,
            left: headerWidth,
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
          {anchorBox}
          {moreBoxes}
          {selectionBox}
          {box && !readOnly && !editing ? (
            <>
              {onDragSelection ? (
                <MoveEdges
                  box={box}
                  rows={rows}
                  cols={cols}
                  content={content}
                  onDrag={onDragSelection}
                />
              ) : null}
              {onFill ? (
                <FillHandle box={box} rows={rows} cols={cols} content={content} onFill={onFill} />
              ) : null}
            </>
          ) : null}
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
          <GridOverlays
            overlays={overlays}
            rows={rows}
            cols={cols}
            rowIndex={rowIndex}
            colIndex={colIndex}
            zoom={zoom}
            selected={selectedOverlay}
            editable={!readOnly && onOverlayChange !== undefined}
            onSelect={onOverlaySelect}
            onChange={onOverlayChange}
            onCommand={onOverlayCommand}
            onLeave={() => scroller.current?.focus({ preventScroll: true })}
          />
          {editing ? (
            <RefOutlines
              text={editing.text}
              sheetName={data.name.toLowerCase()}
              rows={rows}
              cols={cols}
            />
          ) : null}
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
