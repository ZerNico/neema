import { m } from "~/paraglide/messages.js";
import {
  CommentAdd01Icon,
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
import { commentsKey } from "../../client/comments-plugin.ts";
import { LinkPopover } from "./link-popover.tsx";
import { startComment } from "./comment-start.ts";
import { Format } from "./toolbar.tsx";

/**
 * Formatting right where the text is selected, on the same floating surface
 * as the app's other popovers. Only commenting in code blocks, where no other
 * mark applies; hidden for an empty selection.
 */
export function DocumentBubbleMenu({
  editor,
  scroller,
}: {
  editor: Editor;
  /** The panel's scroll area, so the menu stays on the text as it scrolls. */
  scroller: HTMLElement | null;
}) {
  const [linkAnchor, setLinkAnchor] = useState<Element | null>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      inCode: current.isActive("codeBlock"),
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
          // While a comment on the selection is being written, its card is in the way.
          !commentsKey.getState(view)?.compose
        }
        resizeDelay={0}
        // Hidden once the selection has scrolled out of the panel.
        options={{ placement: "top", offset: 8, hide: true, scrollTarget: scroller ?? window }}
        className="bg-popover text-popover-foreground ring-foreground/5 dark:ring-foreground/10 rounded-full p-1 shadow-lg ring-1"
      >
        <Toolbar.Root
          aria-label={m.documents_editor_selection_formatting()}
          className="flex items-center gap-0.5"
        >
          <Format
            icon={CommentAdd01Icon}
            label={m.documents_editor_comment()}
            pressed={false}
            // The selection collapses as the card opens, so the bubble steps aside.
            onPress={() => startComment(editor)}
          />
          {state.inCode ? null : (
            <>
              <Format
                icon={TextBoldIcon}
                label={m.documents_editor_bold()}
                shortcut="⌘B"
                pressed={state.bold}
                onPress={() => toggle((chain) => chain.toggleBold())}
              />
              <Format
                icon={TextItalicIcon}
                label={m.documents_editor_italic()}
                shortcut="⌘I"
                pressed={state.italic}
                onPress={() => toggle((chain) => chain.toggleItalic())}
              />
              <Format
                icon={TextStrikethroughIcon}
                label={m.documents_editor_strikethrough()}
                shortcut="⌘⇧S"
                pressed={state.strike}
                onPress={() => toggle((chain) => chain.toggleStrike())}
              />
              <Format
                icon={SourceCodeIcon}
                label={m.documents_editor_inline_code()}
                shortcut="⌘E"
                pressed={state.code}
                onPress={() => toggle((chain) => chain.toggleCode())}
              />
              <Format
                icon={Link01Icon}
                label={m.documents_editor_link()}
                pressed={state.link}
                onPress={setLinkAnchor}
              />
            </>
          )}
        </Toolbar.Root>
      </BubbleMenu>
      <LinkPopover editor={editor} anchor={linkAnchor} onClose={() => setLinkAnchor(null)} />
    </>
  );
}
