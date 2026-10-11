import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { columnLetters } from "@chat/sheet/a1";
import type { SheetLocale } from "@chat/sheet/locales";
import {
  acceptCompletion,
  completionFor,
  insertRef,
  pointable,
  toggleAbsolute,
} from "./formula-edit.ts";
import { stampOf, stampText } from "./grid-keys.ts";
import type { AxisLayout } from "./layout.ts";
import type { CellEditing, CellRef } from "./selection.ts";

/** A cell by its row and column indexes, as A1. */
const corner = (at: { row: number; col: number }) => `${columnLetters(at.col + 1)}${at.row + 1}`;

/**
 * The cell being typed into: where its caret is, the completion picked, the
 * reference pointing wrote last, and how keys and clicks end or extend it.
 * The text itself is the caller's, in `editing`.
 */
export function useCellEdit({
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
}: {
  editing: CellEditing | null;
  onEditingChange: ((editing: CellEditing | null) => void) | undefined;
  onCommit: ((at: CellRef, text: string) => void) | undefined;
  onCommitSelection: ((text: string) => void) | undefined;
  locale: SheetLocale;
  rows: AxisLayout;
  cols: AxisLayout;
  rowIndex: ReadonlyMap<string, number>;
  colIndex: ReadonlyMap<string, number>;
  select: (row: number, col: number, extend: boolean) => void;
  reveal: (row: number, col: number) => void;
  focusGrid: () => void;
}) {
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
  // An edit begun shows its caret after what is there, as Excel's does; a focused textarea's
  // caret would otherwise start before the character typed to begin it.
  const editingCell = editing ? `${editing.at.r}|${editing.at.c}` : null;
  const shown = !!editing && rowIndex.has(editing.at.r) && colIndex.has(editing.at.c);
  useLayoutEffect(() => {
    const input = editorInput.current;
    if (!input || editingCell === null || !shown) return;
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editingCell, shown]);
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
    focusGrid();
  };
  const cancel = () => {
    ended.current = editing;
    setPointing(null);
    onEditingChange?.(null);
    focusGrid();
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
      const toggled = toggleAbsolute(
        editing.text,
        event.currentTarget.selectionStart ?? caret,
        locale,
      );
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
      focusGrid();
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

  return {
    editorInput,
    caret,
    setCaret,
    picked,
    setPicked,
    pointing,
    setPointing,
    caretAfter,
    rewrite,
    point,
    pointMode,
    commit,
    cancel,
    onEditorKeyDown,
  };
}
