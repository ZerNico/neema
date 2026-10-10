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
  const [draft, setDraft] = useState<string | null>(latex === "" ? "" : null);
  // Opens as it becomes selected, not while it is: closing re-renders before
  // the cursor has moved off it, and would open the field again.
  const [wasSelected, setWasSelected] = useState(selected);
  if (selected !== wasSelected) {
    setWasSelected(selected);
    if (selected && editor.isEditable) setDraft(latex);
  }
  const editing = draft !== null && editor.isEditable;
  const shown = editing ? draft : latex;

  const finish = () => {
    const next = (draft ?? latex).trim();
    setDraft(null);
    const pos = getPos();
    if (typeof pos !== "number") return;
    const chain = editor.chain().focus();
    if (!next) chain.deleteRange({ from: pos, to: pos + node.nodeSize }).run();
    else
      chain
        .command(({ tr }) => {
          if (next !== latex) tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: next });
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
        {shown ? undefined : "Formula"}
      </span>
      <Popover
        open={editing}
        onOpenChange={(next) => {
          if (!next) finish();
        }}
      >
        <PopoverContent anchor={anchor} align={display ? "center" : "start"} className="w-80">
          <Textarea
            aria-label="LaTeX"
            value={draft ?? ""}
            placeholder="E = mc^2"
            onChange={(event) => setDraft(event.target.value)}
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
