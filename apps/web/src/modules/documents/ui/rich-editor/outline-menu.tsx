import { LeftToRightListBulletIcon } from "@hugeicons/core-free-icons";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { DropdownMenuContent, DropdownMenuItem } from "~/ui/primitives/dropdown-menu";
import { ToolbarMenu } from "../ribbon-controls.tsx";
import { documentHeadings } from "./document-stats.ts";

/** The document's headings, indented by level; one jumps to its place in the text. */
export function OutlineMenu({ editor }: { editor: Editor }) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: current }) => documentHeadings(current.state.doc),
  });
  return (
    <ToolbarMenu label="Outline" icon={LeftToRightListBulletIcon} text="Outline">
      <DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto">
        {headings.length ? (
          headings.map((heading) => (
            <DropdownMenuItem
              key={heading.pos}
              // Each level indents a step, as Google Docs' outline does.
              style={{ paddingInlineStart: `${0.5 + (heading.level - 1) * 0.75}rem` }}
              onClick={() =>
                editor.chain().focus().setTextSelection(heading.pos).scrollIntoView().run()
              }
            >
              <span className="truncate">{heading.text || "Untitled heading"}</span>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>Headings you add show here</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </ToolbarMenu>
  );
}
