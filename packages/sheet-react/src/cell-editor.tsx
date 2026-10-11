import type { CSSProperties } from "react";
import { REF_COLORS, acceptCompletion, completionFor, formulaRefs } from "./formula-edit.ts";
import { FormulaPopup } from "./formula-popup.tsx";
import { textWidth, type AxisLayout } from "./layout.ts";
import type { CellEditing } from "./selection.ts";
import type { useCellEdit } from "./use-cell-edit.ts";

/** The input over the cell being edited, and the formula's completions and hints under it. */
export function CellEditor({
  editing,
  rect,
  zoom,
  edit: {
    editorInput,
    caret,
    setCaret,
    picked,
    setPicked,
    setPointing,
    caretAfter,
    rewrite,
    commit,
    onEditorKeyDown,
  },
  onEditingChange,
}: {
  editing: CellEditing;
  rect: { top: number; left: number; width: number; height: number };
  zoom: number;
  edit: ReturnType<typeof useCellEdit>;
  onEditingChange: ((editing: CellEditing | null) => void) | undefined;
}) {
  return (
    <>
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
          ...rect,
          // A text with line breaks grows the editor by a line each, as Excel's does.
          fontSize: 14 * zoom,
          lineHeight: `${16 * zoom}px`,
          width: Math.max(
            rect.width,
            // The text's own width, measured: thin characters take less room than wide ones.
            (Math.max(...editing.text.split("\n").map((line) => textWidth(line))) + 16) * zoom,
          ),
          height: Math.max(rect.height, editing.text.split("\n").length * 16 * zoom + 4),
        }}
      />
      {editing.text.startsWith("=") ? (
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
          style={{ top: rect.top + rect.height + 2, left: rect.left }}
        />
      ) : null}
    </>
  );
}

/** The cells each reference of a formula being typed reads, outlined in its colour. */
export function RefOutlines({
  text,
  sheetName,
  rows,
  cols,
}: {
  text: string;
  sheetName: string;
  rows: AxisLayout;
  cols: AxisLayout;
}) {
  if (!text.startsWith("=")) return [];
  return formulaRefs(text).flatMap((ref, index) => {
    if (ref.sheet !== null && ref.sheet.toLowerCase() !== sheetName) return [];
    const [top, bottom] =
      ref.top === null ? [0, rows.ids.length - 1] : [ref.top - 1, ref.bottom! - 1];
    const [left, right] =
      ref.left === null ? [0, cols.ids.length - 1] : [ref.left - 1, ref.right! - 1];
    if (bottom >= rows.ids.length || right >= cols.ids.length) return [];
    const color = REF_COLORS[index % REF_COLORS.length]!;
    const style: CSSProperties = {
      top: rows.starts[top],
      left: cols.starts[left],
      height: rows.starts[bottom + 1]! - rows.starts[top]!,
      width: cols.starts[right + 1]! - cols.starts[left]!,
      borderColor: color,
      backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
    };
    return [
      <div
        key={`ref-${ref.start}`}
        aria-hidden
        className="pointer-events-none absolute z-10 border-2"
        style={style}
      />,
    ];
  });
}
