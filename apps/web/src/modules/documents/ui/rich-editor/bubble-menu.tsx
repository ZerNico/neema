import {
  Link01Icon,
  SourceCodeIcon,
  TextBoldIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
} from "@hugeicons/core-free-icons";
import { Toolbar } from "@base-ui/react/toolbar";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useState } from "react";
import { LinkPopover } from "./link-popover.tsx";
import { Format } from "./toolbar.tsx";

/**
 * Formatting right where the text is selected, on the same floating surface
 * as the app's other popovers. Hidden in code blocks, where marks do not
 * apply, and for an empty selection.
 */
export function DocumentBubbleMenu({ editor }: { editor: Editor }) {
  const [linkAnchor, setLinkAnchor] = useState<Element | null>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
    }),
  });
  const toggle = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) =>
    command(editor.chain().focus()).run();
  return (
    <>
      <BubbleMenu
        editor={editor}
        // A selected block (a chip, a planned section, a divider) has no text to format.
        shouldShow={({ editor: current, state: view }) =>
          current.isEditable &&
          !view.selection.empty &&
          !(view.selection instanceof NodeSelection) &&
          !current.isActive("codeBlock")
        }
        options={{ placement: "top", offset: 8 }}
        className="bg-popover text-popover-foreground ring-foreground/5 dark:ring-foreground/10 rounded-full p-1 shadow-lg ring-1"
      >
        <Toolbar.Root aria-label="Selection formatting" className="flex items-center gap-0.5">
          <Format
            icon={TextBoldIcon}
            label="Bold"
            shortcut="⌘B"
            pressed={state.bold}
            onPress={() => toggle((chain) => chain.toggleBold())}
          />
          <Format
            icon={TextItalicIcon}
            label="Italic"
            shortcut="⌘I"
            pressed={state.italic}
            onPress={() => toggle((chain) => chain.toggleItalic())}
          />
          <Format
            icon={TextStrikethroughIcon}
            label="Strikethrough"
            shortcut="⌘⇧S"
            pressed={state.strike}
            onPress={() => toggle((chain) => chain.toggleStrike())}
          />
          <Format
            icon={SourceCodeIcon}
            label="Inline code"
            shortcut="⌘E"
            pressed={state.code}
            onPress={() => toggle((chain) => chain.toggleCode())}
          />
          <Format icon={Link01Icon} label="Link" pressed={state.link} onPress={setLinkAnchor} />
        </Toolbar.Root>
      </BubbleMenu>
      <LinkPopover editor={editor} anchor={linkAnchor} onClose={() => setLinkAnchor(null)} />
    </>
  );
}
