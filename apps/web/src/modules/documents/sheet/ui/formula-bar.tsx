import { useRef } from "react";

/**
 * The active cell's address and its formula or value as typed. Focusing it
 * starts an edit of that cell; Enter or Tab writes it, Escape drops it, and
 * focus moving into the cell's own editor carries the edit on there.
 */
export function FormulaBar({
  address,
  text,
  readOnly,
  editing,
  onStart,
  onChange,
  onCommit,
  onCancel,
}: {
  address: string;
  text: string;
  readOnly: boolean;
  /** Whether an edit is going on, here or in the cell. */
  editing: boolean;
  onStart: () => void;
  onChange: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const bar = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <span className="text-muted-foreground w-14 shrink-0 font-mono text-xs">{address}</span>
      {/* A textarea, so a cell's line breaks survive editing here; it shows the first line. */}
      <textarea
        ref={bar}
        aria-label="Formula bar"
        data-sheet-editor="true"
        readOnly={readOnly}
        value={text}
        rows={1}
        spellCheck={false}
        className="text-foreground h-7 min-w-0 flex-1 resize-none overflow-hidden bg-transparent px-2 py-1.5 font-mono text-xs leading-4 whitespace-pre outline-none"
        onFocus={() => {
          if (!readOnly && !editing) onStart();
        }}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!editing) return;
          if (event.key === "Enter" && event.altKey) {
            // Alt+Enter breaks the line inside the cell, as in Excel.
            event.preventDefault();
            const input = event.currentTarget;
            input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
            onChange(input.value);
          } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            onCommit();
            bar.current?.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            bar.current?.blur();
          }
        }}
        onBlur={(event) => {
          if (!editing) return;
          // Into the cell's own editor, the edit carries on there.
          if (event.relatedTarget instanceof HTMLTextAreaElement) return;
          onCommit();
        }}
      />
    </div>
  );
}
