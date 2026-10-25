import { m } from "~/paraglide/messages.js";
import {
  ArrowDown01Icon,
  Calendar03Icon,
  CommentAdd01Icon,
  FunctionOfXIcon,
  SearchReplaceIcon,
  Clock01Icon,
  TextNumberSignIcon,
  UserIcon,
  CheckListIcon,
  CodeSquareIcon,
  ColumnDeleteIcon,
  ColumnInsertIcon,
  Delete02Icon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  Heading04Icon,
  Heading05Icon,
  Heading06Icon,
  InformationSquareIcon,
  ArrowRight01Icon,
  TextFootnoteIcon,
  BulbIcon,
  AlertDiamondIcon,
  Alert02Icon,
  StopIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  MinusSignIcon,
  QuoteDownIcon,
  Redo02Icon,
  RowDeleteIcon,
  RowInsertIcon,
  SourceCodeIcon,
  FunctionIcon,
  LayoutTable01Icon,
  TextBoldIcon,
  TextIcon,
  TextItalicIcon,
  TextUnderlineIcon,
  HighlighterIcon,
  Image01Icon,
  TextStrikethroughIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { Toolbar } from "@base-ui/react/toolbar";
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useState } from "react";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Kbd } from "~/ui/primitives/kbd";
import { Toggle } from "~/ui/primitives/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { LinkPopover } from "./link-popover.tsx";
import { insertFormula } from "./math-item.ts";
import { NodeSelection } from "@tiptap/pm/state";
import { startComment } from "./comment-start.ts";
import { insertDetails, insertFootnote, setCallout } from "./block-items.ts";
import { ToolbarMenu } from "../ribbon-controls.tsx";
import type { CalloutKind } from "../../editor/blocks.ts";
import { setFindOpen } from "./find.ts";
import { setWordCountShown, useWordCountShown } from "./document-stats.ts";
import { OutlineMenu } from "./outline-menu.tsx";
import { Ribbon, type RibbonTab } from "../ribbon.tsx";
import { isoDay } from "./dates.ts";
import { pickImages } from "./image-upload.ts";
import { VersionHistoryDialog } from "./version-history.tsx";

type Chain = ReturnType<Editor["chain"]>;
type Icon = HugeiconsIconProps["icon"];
const run = (editor: Editor, command: (chain: Chain) => Chain) =>
  command(editor.chain().focus()).run();
// A control taking focus would drop the editor's selection first.
const keepSelection = (event: { preventDefault: () => void }) => event.preventDefault();

const heading = (level: number) => () => m.documents_editor_heading({ level });
const BLOCKS = [
  { value: "paragraph", label: m.documents_editor_text, icon: TextIcon },
  { value: "h1", label: heading(1), icon: Heading01Icon },
  { value: "h2", label: heading(2), icon: Heading02Icon },
  { value: "h3", label: heading(3), icon: Heading03Icon },
  { value: "h4", label: heading(4), icon: Heading04Icon },
  { value: "h5", label: heading(5), icon: Heading05Icon },
  { value: "h6", label: heading(6), icon: Heading06Icon },
] as const;
type Block = (typeof BLOCKS)[number]["value"];

/** Callouts by kind, as GitHub names its alerts. */
const CALLOUTS: ReadonlyArray<{ kind: CalloutKind; label: () => string; icon: Icon }> = [
  { kind: "note", label: m.documents_callout_note, icon: InformationSquareIcon },
  { kind: "tip", label: m.documents_callout_tip, icon: BulbIcon },
  { kind: "important", label: m.documents_callout_important, icon: AlertDiamondIcon },
  { kind: "warning", label: m.documents_callout_warning, icon: Alert02Icon },
  { kind: "caution", label: m.documents_callout_caution, icon: StopIcon },
];

const setBlock = (editor: Editor, block: Block) =>
  run(editor, (chain) =>
    block === "paragraph"
      ? chain.setParagraph()
      : chain.setHeading({ level: Number(block.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }),
  );

function Hint({ label, shortcut }: { label: string; shortcut?: string | undefined }) {
  return (
    <TooltipContent>
      {label}
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
    </TooltipContent>
  );
}

/** One formatting button: pressed while its format applies to the selection. */
export function Format({
  icon,
  label,
  shortcut,
  pressed,
  onPress,
}: {
  icon: Icon;
  label: string;
  shortcut?: string | undefined;
  pressed: boolean;
  /** Gets the button, for a popover that opens from it. */
  onPress: (button: HTMLElement) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toolbar.Button
            render={
              <Toggle
                size="icon"
                variant="toolbar"
                pressed={pressed}
                aria-label={label}
                onMouseDown={keepSelection}
                onClick={(event) => onPress(event.currentTarget)}
              />
            }
          />
        }
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} />
      </TooltipTrigger>
      <Hint label={label} shortcut={shortcut} />
    </Tooltip>
  );
}

export function Action({
  icon,
  label,
  shortcut,
  disabled,
  onPress,
}: {
  icon: Icon;
  label: string;
  shortcut?: string | undefined;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toolbar.Button
            // Still reachable by arrow keys while disabled, as a toolbar's items are.
            disabled={disabled}
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={label}
                className="text-muted-foreground"
                onMouseDown={keepSelection}
                onClick={onPress}
              />
            }
          />
        }
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} />
      </TooltipTrigger>
      <Hint label={label} shortcut={shortcut} />
    </Tooltip>
  );
}

const useToolbarState = (editor: Editor) =>
  useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      block: (BLOCKS.find(
        (item) =>
          item.value !== "paragraph" &&
          current.isActive("heading", { level: Number(item.value.slice(1)) }),
      )?.value ?? "paragraph") as Block,
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      underline: current.isActive("underline"),
      highlight: current.isActive("highlight"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      bulletList: current.isActive("bulletList"),
      orderedList: current.isActive("orderedList"),
      taskList: current.isActive("taskList"),
      blockquote: current.isActive("blockquote"),
      codeBlock: current.isActive("codeBlock"),
      table: current.isActive("table"),
      // A comment needs text to sit on: a range of it, not a selected chip or block.
      canComment:
        !current.state.selection.empty && !(current.state.selection instanceof NodeSelection),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });
/** Inserts a node where the selection is, the way the slash menu does. */
const insert = (content: Parameters<Chain["insertContent"]>[0]) => (chain: Chain) =>
  chain.insertContent(content);

/** A chip for the day it is clicked: a ribbon left open past midnight inserts the new day. */
const insertToday = (chain: Chain) =>
  chain.insertContent([
    { type: "dateChip", attrs: { value: isoDay(new Date()) } },
    { type: "text", text: " " },
  ]);

/**
 * The document's ribbon. Every control is a command on the
 * shared tree, so what it does syncs like typing.
 */
export function DocumentToolbar({ editor, documentId }: { editor: Editor; documentId: string }) {
  const state = useToolbarState(editor);
  const wordCount = useWordCountShown();
  const [linkAnchor, setLinkAnchor] = useState<Element | null>(null);
  const [history, setHistory] = useState(false);
  const format = (
    label: string,
    icon: Icon,
    pressed: boolean,
    command: (chain: Chain) => Chain,
    shortcut?: string,
  ) => (
    <Format
      key={label}
      icon={icon}
      label={label}
      shortcut={shortcut}
      pressed={pressed}
      onPress={() => run(editor, command)}
    />
  );
  const action = (label: string, icon: Icon, command: (chain: Chain) => Chain) => (
    <Action
      key={label}
      icon={icon}
      label={label}
      disabled={false}
      onPress={() => run(editor, command)}
    />
  );
  const tabs: RibbonTab<"home" | "insert" | "review" | "view">[] = [
    {
      value: "home",
      label: m.documents_ribbon_tab_home(),
      groups: [
        {
          id: "text",
          label: m.documents_ribbon_group_text(),
          controls: (
            <>
              <TextStyleMenu editor={editor} block={state.block} />
              {format(
                m.documents_editor_bold(),
                TextBoldIcon,
                state.bold,
                (c) => c.toggleBold(),
                "⌘B",
              )}
              {format(
                m.documents_editor_italic(),
                TextItalicIcon,
                state.italic,
                (c) => c.toggleItalic(),
                "⌘I",
              )}
              {format(
                m.documents_editor_underline(),
                TextUnderlineIcon,
                state.underline,
                (c) => c.toggleUnderline(),
                "⌘U",
              )}
              {format(m.documents_editor_highlight(), HighlighterIcon, state.highlight, (c) =>
                c.toggleHighlight(),
              )}
              {format(
                m.documents_editor_strikethrough(),
                TextStrikethroughIcon,
                state.strike,
                (c) => c.toggleStrike(),
                "⌘⇧S",
              )}
              {format(
                m.documents_editor_inline_code(),
                SourceCodeIcon,
                state.code,
                (c) => c.toggleCode(),
                "⌘E",
              )}
              <Format
                icon={Link01Icon}
                label={m.documents_editor_link()}
                pressed={state.link}
                onPress={setLinkAnchor}
              />
            </>
          ),
        },
        {
          id: "paragraph",
          label: m.documents_ribbon_group_paragraph(),
          controls: (
            <>
              {format(
                m.documents_editor_bulleted_list(),
                LeftToRightListBulletIcon,
                state.bulletList,
                (c) => c.toggleBulletList(),
                "⌘⇧8",
              )}
              {format(
                m.documents_editor_numbered_list(),
                LeftToRightListNumberIcon,
                state.orderedList,
                (c) => c.toggleOrderedList(),
                "⌘⇧7",
              )}
              {format(
                m.documents_editor_checklist(),
                CheckListIcon,
                state.taskList,
                (c) => c.toggleTaskList(),
                "⌘⇧9",
              )}
              {format(
                m.documents_editor_quote(),
                QuoteDownIcon,
                state.blockquote,
                (c) => c.toggleBlockquote(),
                "⌘⇧B",
              )}
              {format(
                m.documents_editor_code_block(),
                CodeSquareIcon,
                state.codeBlock,
                (c) => c.toggleCodeBlock(),
                "⌘⌥C",
              )}
            </>
          ),
        },
        {
          id: "editing",
          label: m.documents_ribbon_group_editing(),
          controls: (
            <Action
              icon={SearchReplaceIcon}
              label={m.documents_editor_find_replace()}
              shortcut="⌘⇧H"
              disabled={false}
              onPress={() => setFindOpen(editor, "replace")}
            />
          ),
        },
      ],
    },
    {
      value: "insert",
      label: m.documents_ribbon_tab_insert(),
      groups: [
        {
          id: "tables",
          label: m.documents_ribbon_group_tables(),
          controls: <TableMenu editor={editor} inTable={state.table} />,
        },
        {
          id: "math",
          label: m.documents_ribbon_group_formulas(),
          controls: (
            <>
              {action(m.documents_editor_formula(), FunctionIcon, insertFormula)}
              {action(
                m.documents_editor_inline_formula(),
                FunctionOfXIcon,
                insert({ type: "inlineMath", attrs: { latex: "" } }),
              )}
            </>
          ),
        },
        {
          id: "blocks",
          label: m.documents_ribbon_group_blocks(),
          controls: (
            <>
              <Action
                icon={Image01Icon}
                label={m.documents_editor_image()}
                disabled={false}
                onPress={() => pickImages(editor)}
              />
              {action(m.documents_editor_divider(), MinusSignIcon, (c) => c.setHorizontalRule())}
              {action(m.documents_editor_date(), Calendar03Icon, insertToday)}
              {action(m.documents_editor_mention(), UserIcon, insert("@"))}
            </>
          ),
        },
        {
          id: "sections",
          label: m.documents_ribbon_group_sections(),
          controls: (
            <>
              <ToolbarMenu label={m.documents_editor_callout()} icon={InformationSquareIcon}>
                <DropdownMenuContent align="start" className="w-44">
                  {CALLOUTS.map((callout) => (
                    <DropdownMenuItem
                      key={callout.kind}
                      onClick={() => run(editor, setCallout(callout.kind))}
                    >
                      <HugeiconsIcon icon={callout.icon} strokeWidth={2} />
                      {callout.label()}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </ToolbarMenu>
              {action(m.documents_editor_collapsible(), ArrowRight01Icon, insertDetails)}
              {action(m.documents_editor_footnote(), TextFootnoteIcon, insertFootnote)}
            </>
          ),
        },
      ],
    },
    {
      value: "review",
      label: m.documents_ribbon_tab_review(),
      groups: [
        {
          id: "comments",
          label: m.documents_ribbon_group_comments(),
          controls: (
            <Action
              icon={CommentAdd01Icon}
              label={m.documents_editor_new_comment()}
              disabled={!state.canComment}
              onPress={() => startComment(editor)}
            />
          ),
        },
        {
          id: "history",
          label: m.documents_ribbon_group_history(),
          controls: (
            <Action
              icon={Clock01Icon}
              label={m.documents_editor_version_history()}
              disabled={false}
              onPress={() => setHistory(true)}
            />
          ),
        },
      ],
    },
    {
      value: "view",
      label: m.documents_ribbon_tab_view(),
      groups: [
        {
          id: "navigate",
          label: m.documents_ribbon_group_navigate(),
          controls: <OutlineMenu editor={editor} />,
        },
        {
          id: "show",
          label: m.documents_ribbon_group_show(),
          controls: (
            <Format
              icon={TextNumberSignIcon}
              label={m.documents_editor_word_count()}
              pressed={wordCount}
              onPress={() => setWordCountShown(!wordCount)}
            />
          ),
        },
      ],
    },
  ];
  return (
    <>
      <Ribbon
        tabs={tabs}
        history={
          <>
            <Action
              icon={Undo02Icon}
              label={m.documents_editor_undo()}
              shortcut="⌘Z"
              disabled={!state.canUndo}
              onPress={() => run(editor, (c) => c.undo())}
            />
            <Action
              icon={Redo02Icon}
              label={m.documents_editor_redo()}
              shortcut="⌘⇧Z"
              disabled={!state.canRedo}
              onPress={() => run(editor, (c) => c.redo())}
            />
          </>
        }
      />
      <LinkPopover editor={editor} anchor={linkAnchor} onClose={() => setLinkAnchor(null)} />
      {/* Mounted while open: its queries belong to the history, not the toolbar. */}
      {history ? (
        <VersionHistoryDialog
          editor={editor}
          documentId={documentId}
          open
          onOpenChange={setHistory}
        />
      ) : null}
    </>
  );
}

/** The text style of the block the selection starts in: text or a heading. */
function TextStyleMenu({ editor, block }: { editor: Editor; block: Block }) {
  const shown = BLOCKS.find((item) => item.value === block) ?? BLOCKS[0];
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toolbar.Button
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={m.documents_editor_text_style_current({ style: shown.label() })}
                      className="text-muted-foreground"
                      onMouseDown={keepSelection}
                    />
                  }
                />
              }
            />
          }
        >
          <HugeiconsIcon icon={shown.icon} strokeWidth={2} />
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} data-icon="inline-end" />
        </TooltipTrigger>
        <Hint label={m.documents_editor_text_style()} />
      </Tooltip>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuRadioGroup
          value={block}
          onValueChange={(value: Block) => setBlock(editor, value)}
        >
          {BLOCKS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              <HugeiconsIcon icon={item.icon} strokeWidth={2} />
              {item.label()}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InsertTableItem({ editor }: { editor: Editor }) {
  return (
    <DropdownMenuItem
      onClick={() =>
        run(editor, (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))
      }
    >
      <HugeiconsIcon icon={LayoutTable01Icon} strokeWidth={2} />
      {m.documents_table_insert()}
    </DropdownMenuItem>
  );
}

function TableItems({ editor }: { editor: Editor }) {
  return (
    <>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.addRowBefore())}>
        <HugeiconsIcon icon={RowInsertIcon} strokeWidth={2} />
        {m.documents_table_add_row_above()}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.addRowAfter())}>
        <HugeiconsIcon icon={RowInsertIcon} strokeWidth={2} />
        {m.documents_table_add_row_below()}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.addColumnBefore())}>
        <HugeiconsIcon icon={ColumnInsertIcon} strokeWidth={2} />
        {m.documents_table_add_column_left()}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.addColumnAfter())}>
        <HugeiconsIcon icon={ColumnInsertIcon} strokeWidth={2} />
        {m.documents_table_add_column_right()}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.deleteRow())}>
        <HugeiconsIcon icon={RowDeleteIcon} strokeWidth={2} />
        {m.documents_table_delete_row()}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.deleteColumn())}>
        <HugeiconsIcon icon={ColumnDeleteIcon} strokeWidth={2} />
        {m.documents_table_delete_column()}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        onClick={() => run(editor, (chain) => chain.deleteTable())}
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        {m.documents_table_delete()}
      </DropdownMenuItem>
    </>
  );
}

/** Inserts a table, or edits the one the selection is in. */
function TableMenu({ editor, inTable }: { editor: Editor; inTable: boolean }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toolbar.Button
              render={
                <DropdownMenuTrigger
                  render={
                    <Toggle
                      size="icon"
                      variant="toolbar"
                      pressed={inTable}
                      aria-label={m.documents_editor_table()}
                      onMouseDown={keepSelection}
                    />
                  }
                />
              }
            />
          }
        >
          <HugeiconsIcon icon={LayoutTable01Icon} strokeWidth={2} />
        </TooltipTrigger>
        <Hint label={m.documents_editor_table()} />
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        {inTable ? <TableItems editor={editor} /> : <InsertTableItem editor={editor} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
