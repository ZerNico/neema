import { toastError } from "~/ui/error-toast.ts";
import type { Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import {
  AiChat02Icon,
  Calendar03Icon,
  CheckListIcon,
  CodeSquareIcon,
  ColumnDeleteIcon,
  Copy01Icon,
  Delete02Icon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  LayoutAlignBottomIcon,
  LayoutAlignLeftIcon,
  LayoutAlignRightIcon,
  LayoutAlignTopIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  MinusSignIcon,
  QuoteDownIcon,
  RowDeleteIcon,
  SortByDown01Icon,
  SortByUp01Icon,
  TableColumnsSplitIcon,
  TableRowsSplitIcon,
  ScissorIcon,
  SourceCodeIcon,
  LayoutTable01Icon,
  TaskDaily01Icon,
  TextBoldIcon,
  TextIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
} from "@hugeicons/core-free-icons";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "~/ui/primitives/context-menu";
import { isoDay } from "./dates.ts";
import { sortColumn } from "./table-sort.ts";
import { editorHooks } from "./editor-hooks.ts";

type Chain = ReturnType<Editor["chain"]>;

function Item({
  icon,
  label,
  shortcut,
  disabled,
  variant,
  onClick,
}: {
  icon: HugeiconsIconProps["icon"];
  label: string;
  shortcut?: string;
  disabled?: boolean;
  variant?: "destructive";
  onClick: () => void;
}) {
  return (
    <ContextMenuItem disabled={disabled} onClick={onClick} {...(variant ? { variant } : {})}>
      <HugeiconsIcon icon={icon} strokeWidth={2} />
      {label}
      {shortcut ? <ContextMenuShortcut>{shortcut}</ContextMenuShortcut> : null}
    </ContextMenuItem>
  );
}

/**
 * The editor's own right-click menu: the clipboard, marks for a selection,
 * turning the block into another kind, inserting, the table's rows and
 * columns when the click is in one, and asking about the selection. Shift
 * right-click keeps the browser's menu, for its spelling suggestions.
 */
export function EditorContextMenu({ editor, children }: { editor: Editor; children: ReactNode }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      empty: current.state.selection.empty,
      table: current.isActive("table"),
      editable: current.isEditable,
    }),
  });
  const run = (command: (chain: Chain) => Chain) => command(editor.chain().focus()).run();
  const selected = () => {
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, "\n\n", " ");
  };
  const focusComposer = editorHooks(editor).focusComposer;
  return (
    <ContextMenu>
      <ContextMenuPrimitive.Trigger
        render={<div className="flex grow flex-col" />}
        onContextMenu={(event) => {
          if (event.shiftKey || !editor.isEditable) {
            event.preventBaseUIHandler();
            return;
          }
          // A click outside the selection moves the cursor there, so table
          // actions apply to the cell that was clicked.
          const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
          const { from, to } = editor.state.selection;
          if (at && (at.pos < from || at.pos > to)) editor.commands.setTextSelection(at.pos);
        }}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuContent className="w-56">
        <Item
          icon={ScissorIcon}
          label="Cut"
          shortcut="⌘X"
          disabled={state.empty}
          onClick={() => {
            // Removed only once it is on the clipboard: a refused write must not
            // lose the text. The range cut follows every edit landing meanwhile,
            // and goes only if it still holds what was copied.
            const text = selected();
            const { from, to } = editor.state.selection;
            const moved = new Mapping();
            const follow = ({ transaction }: { transaction: Transaction }) =>
              moved.appendMapping(transaction.mapping);
            editor.on("transaction", follow);
            void navigator.clipboard
              .writeText(text)
              .then(() => {
                const range = { from: moved.map(from, 1), to: moved.map(to, -1) };
                const still = editor.state.doc.textBetween(range.from, range.to, "\n\n", " ");
                if (range.from < range.to && still === text)
                  editor.chain().focus().deleteRange(range).run();
              })
              .catch((error: unknown) => toastError("Couldn’t cut the selection.", error))
              .finally(() => editor.off("transaction", follow));
          }}
        />
        <Item
          icon={Copy01Icon}
          label="Copy"
          shortcut="⌘C"
          disabled={state.empty}
          onClick={() => void navigator.clipboard.writeText(selected())}
        />
        <Item
          icon={TaskDaily01Icon}
          label="Paste"
          shortcut="⌘V"
          onClick={() =>
            void navigator.clipboard.readText().then(
              (text) => run((chain) => chain.insertContent(text)),
              () => {},
            )
          }
        />
        {focusComposer && !state.empty ? (
          <>
            <ContextMenuSeparator />
            <Item icon={AiChat02Icon} label="Ask about the selection" onClick={focusComposer} />
          </>
        ) : null}
        {state.empty ? null : (
          <>
            <ContextMenuSeparator />
            <Item
              icon={TextBoldIcon}
              label="Bold"
              shortcut="⌘B"
              onClick={() => run((c) => c.toggleBold())}
            />
            <Item
              icon={TextItalicIcon}
              label="Italic"
              shortcut="⌘I"
              onClick={() => run((c) => c.toggleItalic())}
            />
            <Item
              icon={TextStrikethroughIcon}
              label="Strikethrough"
              onClick={() => run((c) => c.toggleStrike())}
            />
            <Item
              icon={SourceCodeIcon}
              label="Inline code"
              onClick={() => run((c) => c.toggleCode())}
            />
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <HugeiconsIcon icon={TextIcon} strokeWidth={2} />
            Turn into
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <Item icon={TextIcon} label="Text" onClick={() => run((c) => c.setParagraph())} />
            <Item
              icon={Heading01Icon}
              label="Heading 1"
              onClick={() => run((c) => c.setHeading({ level: 1 }))}
            />
            <Item
              icon={Heading02Icon}
              label="Heading 2"
              onClick={() => run((c) => c.setHeading({ level: 2 }))}
            />
            <Item
              icon={Heading03Icon}
              label="Heading 3"
              onClick={() => run((c) => c.setHeading({ level: 3 }))}
            />
            <Item
              icon={LeftToRightListBulletIcon}
              label="Bulleted list"
              onClick={() => run((c) => c.toggleBulletList())}
            />
            <Item
              icon={LeftToRightListNumberIcon}
              label="Numbered list"
              onClick={() => run((c) => c.toggleOrderedList())}
            />
            <Item
              icon={CheckListIcon}
              label="Checklist"
              onClick={() => run((c) => c.toggleTaskList())}
            />
            <Item
              icon={QuoteDownIcon}
              label="Quote"
              onClick={() => run((c) => c.toggleBlockquote())}
            />
            <Item
              icon={CodeSquareIcon}
              label="Code block"
              onClick={() => run((c) => c.toggleCodeBlock())}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <HugeiconsIcon icon={LayoutTable01Icon} strokeWidth={2} />
            Insert
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <Item
              icon={Calendar03Icon}
              label="Date"
              onClick={() =>
                run((c) =>
                  c.insertContent([
                    { type: "dateChip", attrs: { value: isoDay(new Date()) } },
                    { type: "text", text: " " },
                  ]),
                )
              }
            />
            <Item
              icon={LayoutTable01Icon}
              label="Table"
              onClick={() => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
            />
            <Item
              icon={MinusSignIcon}
              label="Divider"
              onClick={() => run((c) => c.setHorizontalRule())}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
        {state.table ? (
          <>
            <ContextMenuSeparator />
            <Item
              icon={LayoutAlignTopIcon}
              label="Add row above"
              onClick={() => run((c) => c.addRowBefore())}
            />
            <Item
              icon={LayoutAlignBottomIcon}
              label="Add row below"
              onClick={() => run((c) => c.addRowAfter())}
            />
            <Item
              icon={LayoutAlignLeftIcon}
              label="Add column left"
              onClick={() => run((c) => c.addColumnBefore())}
            />
            <Item
              icon={LayoutAlignRightIcon}
              label="Add column right"
              onClick={() => run((c) => c.addColumnAfter())}
            />
            <Item
              icon={RowDeleteIcon}
              label="Delete row"
              onClick={() => run((c) => c.deleteRow())}
            />
            <Item
              icon={ColumnDeleteIcon}
              label="Delete column"
              onClick={() => run((c) => c.deleteColumn())}
            />
            <ContextMenuSeparator />
            <Item
              icon={TableRowsSplitIcon}
              label="Toggle header row"
              onClick={() => run((c) => c.toggleHeaderRow())}
            />
            <Item
              icon={TableColumnsSplitIcon}
              label="Toggle header column"
              onClick={() => run((c) => c.toggleHeaderColumn())}
            />
            <ContextMenuSeparator />
            <Item
              icon={SortByUp01Icon}
              label="Sort column ascending"
              onClick={() => sortColumn(editor, 1)}
            />
            <Item
              icon={SortByDown01Icon}
              label="Sort column descending"
              onClick={() => sortColumn(editor, -1)}
            />
            <ContextMenuSeparator />
            <Item
              icon={Delete02Icon}
              label="Delete table"
              variant="destructive"
              onClick={() => run((c) => c.deleteTable())}
            />
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
