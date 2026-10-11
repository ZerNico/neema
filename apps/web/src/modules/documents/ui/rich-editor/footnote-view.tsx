import { Selection } from "@tiptap/pm/state";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { Popover, PopoverContent } from "~/ui/primitives/popover";
import { Textarea } from "~/ui/primitives/textarea";
import { cn } from "~/ui/utils";

/**
 * A footnote as its number, counted by CSS among the others so it renumbers
 * as notes come and go. Selecting it opens its note beneath it, and one just
 * inserted opens straight away; a reader sees the note there too. The note is
 * written when the field closes; emptied, the footnote goes.
 */
export function FootnoteView({ node, selected, editor, getPos }: ReactNodeViewProps) {
  const note = String(node.attrs.note ?? "");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(note === "");
  // Null until the person types, so a collaborator's change shows and closing untouched writes nothing.
  const [typed, setTyped] = useState<string | null>(null);
  // Opens as it becomes selected, as a formula does, not again while it stays selected.
  const [wasSelected, setWasSelected] = useState(false);
  if (selected !== wasSelected) {
    setWasSelected(selected);
    if (selected) {
      setOpen(true);
      setTyped(null);
    }
  }
  const editing = open && editor.isEditable;
  const value = typed ?? note;

  const finish = () => {
    const next = value.trim();
    setOpen(false);
    setTyped(null);
    if (!editor.isEditable) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    const chain = editor.chain().focus();
    if (!next) chain.deleteRange({ from: pos, to: pos + node.nodeSize }).run();
    else
      chain
        .command(({ tr }) => {
          if (typed !== null && next !== note)
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, note: next });
          tr.setSelection(Selection.near(tr.doc.resolve(pos + node.nodeSize)));
          return true;
        })
        .run();
  };

  return (
    <NodeViewWrapper as="span" data-footnote="" contentEditable={false} className="select-none">
      <sup>
        <button
          ref={setAnchor}
          type="button"
          aria-label={note ? `Footnote: ${note}` : "Footnote"}
          className={cn(
            "footnote-number text-primary rounded-sm px-0.5 font-medium",
            (selected || open) && "ring-ring/50 ring-2",
          )}
          // A click opens the note without moving the caret.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen(true)}
        />
      </sup>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next) finish();
        }}
      >
        <PopoverContent anchor={anchor} align="start" className="w-80">
          {editing ? (
            <Textarea
              aria-label="Footnote"
              value={value}
              placeholder="The note, as it appears at the foot of the page"
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                finish();
              }}
            />
          ) : (
            <p className="text-sm">{note}</p>
          )}
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}
