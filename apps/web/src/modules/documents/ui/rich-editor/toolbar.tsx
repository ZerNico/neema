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

const BLOCKS = [
  { value: "paragraph", label: "Text", icon: TextIcon },
  { value: "h1", label: "Heading 1", icon: Heading01Icon },
  { value: "h2", label: "Heading 2", icon: Heading02Icon },
  { value: "h3", label: "Heading 3", icon: Heading03Icon },
  { value: "h4", label: "Heading 4", icon: Heading04Icon },
  { value: "h5", label: "Heading 5", icon: Heading05Icon },
  { value: "h6", label: "Heading 6", icon: Heading06Icon },
] as const;
type Block = (typeof BLOCKS)[number]["value"];

/** Callouts by kind, as GitHub names its alerts. */
const CALLOUTS: ReadonlyArray<{ kind: CalloutKind; label: string; icon: Icon }> = [
  { kind: "note", label: "Note", icon: InformationSquareIcon },
  { kind: "tip", label: "Tip", icon: BulbIcon },
  { kind: "important", label: "Important", icon: AlertDiamondIcon },
  { kind: "warning", label: "Warning", icon: Alert02Icon },
  { kind: "caution", label: "Caution", icon: StopIcon },
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
      label: "Home",
      groups: [
        {
          id: "text",
          label: "Text",
          controls: (
            <>
              <TextStyleMenu editor={editor} block={state.block} />
              {format("Bold", TextBoldIcon, state.bold, (c) => c.toggleBold(), "⌘B")}
              {format("Italic", TextItalicIcon, state.italic, (c) => c.toggleItalic(), "⌘I")}
              {format(
                "Underline",
                TextUnderlineIcon,
                state.underline,
                (c) => c.toggleUnderline(),
                "⌘U",
              )}
              {format("Highlight", HighlighterIcon, state.highlight, (c) => c.toggleHighlight())}
              {format(
                "Strikethrough",
                TextStrikethroughIcon,
                state.strike,
                (c) => c.toggleStrike(),
                "⌘⇧S",
              )}
              {format("Inline code", SourceCodeIcon, state.code, (c) => c.toggleCode(), "⌘E")}
              <Format icon={Link01Icon} label="Link" pressed={state.link} onPress={setLinkAnchor} />
            </>
          ),
        },
        {
          id: "paragraph",
          label: "Paragraph",
          controls: (
            <>
              {format(
                "Bulleted list",
                LeftToRightListBulletIcon,
                state.bulletList,
                (c) => c.toggleBulletList(),
                "⌘⇧8",
              )}
              {format(
                "Numbered list",
                LeftToRightListNumberIcon,
                state.orderedList,
                (c) => c.toggleOrderedList(),
                "⌘⇧7",
              )}
              {format("Checklist", CheckListIcon, state.taskList, (c) => c.toggleTaskList(), "⌘⇧9")}
              {format("Quote", QuoteDownIcon, state.blockquote, (c) => c.toggleBlockquote(), "⌘⇧B")}
              {format(
                "Code block",
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
          label: "Editing",
          controls: (
            <Action
              icon={SearchReplaceIcon}
              label="Find and replace"
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
      label: "Insert",
      groups: [
        {
          id: "tables",
          label: "Tables",
          controls: <TableMenu editor={editor} inTable={state.table} />,
        },
        {
          id: "math",
          label: "Formulas",
          controls: (
            <>
              {action("Formula", FunctionIcon, insertFormula)}
              {action(
                "Inline formula",
                FunctionOfXIcon,
                insert({ type: "inlineMath", attrs: { latex: "" } }),
              )}
            </>
          ),
        },
        {
          id: "blocks",
          label: "Blocks",
          controls: (
            <>
              <Action
                icon={Image01Icon}
                label="Image"
                disabled={false}
                onPress={() => pickImages(editor)}
              />
              {action("Divider", MinusSignIcon, (c) => c.setHorizontalRule())}
              {action("Date", Calendar03Icon, insertToday)}
              {action("Mention someone", UserIcon, insert("@"))}
            </>
          ),
        },
        {
          id: "sections",
          label: "Sections",
          controls: (
            <>
              <ToolbarMenu label="Callout" icon={InformationSquareIcon}>
                <DropdownMenuContent align="start" className="w-44">
                  {CALLOUTS.map((callout) => (
                    <DropdownMenuItem
                      key={callout.kind}
                      onClick={() => run(editor, setCallout(callout.kind))}
                    >
                      <HugeiconsIcon icon={callout.icon} strokeWidth={2} />
                      {callout.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </ToolbarMenu>
              {action("Collapsible section", ArrowRight01Icon, insertDetails)}
              {action("Footnote", TextFootnoteIcon, insertFootnote)}
            </>
          ),
        },
      ],
    },
    {
      value: "review",
      label: "Review",
      groups: [
        {
          id: "comments",
          label: "Comments",
          controls: (
            <Action
              icon={CommentAdd01Icon}
              label="New comment"
              disabled={!state.canComment}
              onPress={() => startComment(editor)}
            />
          ),
        },
        {
          id: "history",
          label: "History",
          controls: (
            <Action
              icon={Clock01Icon}
              label="Version history"
              disabled={false}
              onPress={() => setHistory(true)}
            />
          ),
        },
      ],
    },
    {
      value: "view",
      label: "View",
      groups: [
        {
          id: "navigate",
          label: "Navigate",
          controls: <OutlineMenu editor={editor} />,
        },
        {
          id: "show",
          label: "Show",
          controls: (
            <Format
              icon={TextNumberSignIcon}
              label="Word count"
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
              label="Undo"
              shortcut="⌘Z"
              disabled={!state.canUndo}
              onPress={() => run(editor, (c) => c.undo())}
            />
            <Action
              icon={Redo02Icon}
              label="Redo"
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
                      aria-label={`Text style: ${shown.label}`}
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
        <Hint label="Text style" />
      </Tooltip>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuRadioGroup
          value={block}
          onValueChange={(value: Block) => setBlock(editor, value)}
        >
          {BLOCKS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              <HugeiconsIcon icon={item.icon} strokeWidth={2} />
              {item.label}
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
      Insert table
    </DropdownMenuItem>
  );
}

function TableItems({ editor }: { editor: Editor }) {
  return (
    <>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.addRowBefore())}>
        <HugeiconsIcon icon={RowInsertIcon} strokeWidth={2} />
        Add row above
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.addRowAfter())}>
        <HugeiconsIcon icon={RowInsertIcon} strokeWidth={2} />
        Add row below
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.addColumnBefore())}>
        <HugeiconsIcon icon={ColumnInsertIcon} strokeWidth={2} />
        Add column left
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.addColumnAfter())}>
        <HugeiconsIcon icon={ColumnInsertIcon} strokeWidth={2} />
        Add column right
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.deleteRow())}>
        <HugeiconsIcon icon={RowDeleteIcon} strokeWidth={2} />
        Delete row
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => run(editor, (chain) => chain.deleteColumn())}>
        <HugeiconsIcon icon={ColumnDeleteIcon} strokeWidth={2} />
        Delete column
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        onClick={() => run(editor, (chain) => chain.deleteTable())}
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        Delete table
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
                      aria-label="Table"
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
        <Hint label="Table" />
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        {inTable ? <TableItems editor={editor} /> : <InsertTableItem editor={editor} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
