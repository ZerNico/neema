import { m } from "~/paraglide/messages.js";
import { Selection } from "@tiptap/pm/state";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { renderToString } from "katex";
import { useState } from "react";
import { Popover, PopoverContent } from "~/ui/primitives/popover";
import { Textarea } from "~/ui/primitives/textarea";
import { cn } from "~/ui/utils";

/** KaTeX marks a formula it cannot read in place rather than throwing. */
const typeset = (latex: string, displayMode: boolean) =>
  renderToString(latex, { displayMode, throwOnError: false });

/**
 * A formula drawn by KaTeX. Selecting it, by a click or the keyboard, opens
 * its LaTeX beneath it, and one just inserted opens straight away. The LaTeX
 * is written to the document when the field closes; emptied, the formula goes.
 */
export function MathView({ node, selected, editor, getPos }: ReactNodeViewProps) {
  const display = node.type.name === "blockMath";
  const latex = String(node.attrs.latex ?? "");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // A formula just inserted opens for its LaTeX.
  const [open, setOpen] = useState(latex === "");
  // Null until the person types, so the field follows a collaborator's change
  // to the formula, and closing it untouched writes nothing back.
  const [typed, setTyped] = useState<string | null>(null);
  // Opens as it becomes selected, not while it is: closing re-renders before
  // the cursor has moved off it, and would open the field again. One created
  // selected, as the toolbar inserts it, counts as becoming selected.
  const [wasSelected, setWasSelected] = useState(false);
  if (selected !== wasSelected) {
    setWasSelected(selected);
    if (selected) {
      setOpen(true);
      setTyped(null);
    }
  }
  const editing = open && editor.isEditable;
  const value = typed ?? latex;
  const shown = editing ? value : latex;

  const finish = () => {
    const next = value.trim();
    setOpen(false);
    setTyped(null);
    const pos = getPos();
    if (typeof pos !== "number") return;
    const chain = editor.chain().focus();
    if (!next) chain.deleteRange({ from: pos, to: pos + node.nodeSize }).run();
    else
      chain
        .command(({ tr }) => {
          if (typed !== null && next !== latex)
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: next });
          // After a display formula is between blocks, so the nearest place to type.
          tr.setSelection(Selection.near(tr.doc.resolve(pos + node.nodeSize)));
          return true;
        })
        .run();
  };

  return (
    <NodeViewWrapper
      as={display ? "div" : "span"}
      contentEditable={false}
      className={cn(display ? "my-3 flex justify-center" : "inline", "select-none")}
    >
      <span
        ref={setAnchor}
        className={cn(
          "rounded-md",
          display ? "max-w-full overflow-x-auto px-2 py-1" : "px-0.5",
          (selected || editing) && "ring-ring/50 ring-2",
          !shown && "text-muted-foreground",
        )}
        // KaTeX's own output: it escapes the LaTeX, and with trust off it allows no links or HTML.
        dangerouslySetInnerHTML={shown ? { __html: typeset(shown, display) } : undefined}
      >
        {shown ? undefined : m.documents_editor_formula()}
      </span>
      <Popover
        open={editing}
        onOpenChange={(next) => {
          if (!next) finish();
        }}
      >
        <PopoverContent anchor={anchor} align={display ? "center" : "start"} className="w-80">
          <Textarea
            // oxlint-disable-next-line i18n/no-literal-text -- the language's name
            aria-label="LaTeX"
            value={value}
            // oxlint-disable-next-line i18n/no-literal-text -- a formula, the same in every language
            placeholder="E = mc^2"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              finish();
            }}
          />
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}
