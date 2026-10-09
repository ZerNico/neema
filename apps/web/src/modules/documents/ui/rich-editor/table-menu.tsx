import {
  ColumnDeleteIcon,
  Delete02Icon,
  LayoutAlignBottomIcon,
  LayoutAlignLeftIcon,
  LayoutAlignRightIcon,
  LayoutAlignTopIcon,
  RowDeleteIcon,
} from "@hugeicons/core-free-icons";
import { Toolbar } from "@base-ui/react/toolbar";
import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import { Separator } from "~/ui/primitives/separator";
import { Action } from "./toolbar.tsx";

type Chain = ReturnType<Editor["chain"]>;

/**
 * Rows and columns, edited where the cursor is: shown above the table while
 * the cursor sits in a cell, so a table is changed without hunting through
 * the toolbar. A text selection gets the formatting bubble instead.
 */
export function DocumentTableMenu({ editor }: { editor: Editor }) {
  const run = (command: (chain: Chain) => Chain) => command(editor.chain().focus()).run();
  // Anchored to the table's own top edge, so it never covers the row being edited.
  const tableEdge = () => {
    const { node } = editor.view.domAtPos(editor.state.selection.from);
    const table = (node instanceof Element ? node : node.parentElement)?.closest("table");
    return table ? { getBoundingClientRect: () => table.getBoundingClientRect() } : null;
  };
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="documentTableMenu"
      shouldShow={({ editor: current, state }) =>
        current.isEditable && current.isActive("table") && state.selection.empty
      }
      getReferencedVirtualElement={tableEdge}
      options={{ placement: "top-end", offset: 6 }}
      className="bg-popover text-popover-foreground ring-foreground/5 dark:ring-foreground/10 rounded-full p-1 shadow-lg ring-1"
    >
      <Toolbar.Root aria-label="Table" className="flex items-center gap-0.5">
        <Action
          icon={LayoutAlignTopIcon}
          label="Add row above"
          disabled={false}
          onPress={() => run((chain) => chain.addRowBefore())}
        />
        <Action
          icon={LayoutAlignBottomIcon}
          label="Add row below"
          disabled={false}
          onPress={() => run((chain) => chain.addRowAfter())}
        />
        <Action
          icon={LayoutAlignLeftIcon}
          label="Add column left"
          disabled={false}
          onPress={() => run((chain) => chain.addColumnBefore())}
        />
        <Action
          icon={LayoutAlignRightIcon}
          label="Add column right"
          disabled={false}
          onPress={() => run((chain) => chain.addColumnAfter())}
        />
        <Separator orientation="vertical" className="mx-0.5 h-5" />
        <Action
          icon={RowDeleteIcon}
          label="Delete row"
          disabled={false}
          onPress={() => run((chain) => chain.deleteRow())}
        />
        <Action
          icon={ColumnDeleteIcon}
          label="Delete column"
          disabled={false}
          onPress={() => run((chain) => chain.deleteColumn())}
        />
        <Action
          icon={Delete02Icon}
          label="Delete table"
          disabled={false}
          onPress={() => run((chain) => chain.deleteTable())}
        />
      </Toolbar.Root>
    </BubbleMenu>
  );
}
