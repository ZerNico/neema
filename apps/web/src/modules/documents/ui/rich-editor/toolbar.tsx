import {
  ArrowDown01Icon,
  CheckListIcon,
  CodeSquareIcon,
  ColumnDeleteIcon,
  ColumnInsertIcon,
  Delete02Icon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  MinusSignIcon,
  MoreHorizontalIcon,
  QuoteDownIcon,
  Redo02Icon,
  RowDeleteIcon,
  RowInsertIcon,
  SourceCodeIcon,
  Table01Icon,
  TextBoldIcon,
  TextIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { Toolbar } from "@base-ui/react/toolbar";
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Kbd } from "~/ui/primitives/kbd";
import { Toggle } from "~/ui/primitives/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { LinkPopover } from "./link-popover.tsx";
import { fittingControls } from "./fitting-controls.ts";

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
] as const;
type Block = (typeof BLOCKS)[number]["value"];

const setBlock = (editor: Editor, block: Block) =>
  run(editor, (chain) =>
    block === "paragraph"
      ? chain.setParagraph()
      : chain.setHeading({ level: Number(block.slice(1)) as 1 | 2 | 3 }),
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
      block: (current.isActive("heading", { level: 1 })
        ? "h1"
        : current.isActive("heading", { level: 2 })
          ? "h2"
          : current.isActive("heading", { level: 3 })
            ? "h3"
            : "paragraph") as Block,
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      bulletList: current.isActive("bulletList"),
      orderedList: current.isActive("orderedList"),
      taskList: current.isActive("taskList"),
      blockquote: current.isActive("blockquote"),
      codeBlock: current.isActive("codeBlock"),
      table: current.isActive("table"),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });
type ToolbarState = ReturnType<typeof useToolbarState>;

type Control =
  | {
      kind: "format";
      label: string;
      icon: Icon;
      shortcut?: string | undefined;
      pressed: keyof ToolbarState;
      command: (chain: Chain) => Chain;
    }
  | {
      kind: "action";
      label: string;
      icon: Icon;
      shortcut?: string | undefined;
      enabled?: "canUndo" | "canRedo";
      command: (chain: Chain) => Chain;
    }
  | { kind: "link" | "table"; label: string; icon: Icon };

/** In the order they give way: the last ones move into More first. */
const CONTROLS: Control[] = [
  {
    kind: "format",
    label: "Bold",
    icon: TextBoldIcon,
    shortcut: "⌘B",
    pressed: "bold",
    command: (c) => c.toggleBold(),
  },
  {
    kind: "format",
    label: "Italic",
    icon: TextItalicIcon,
    shortcut: "⌘I",
    pressed: "italic",
    command: (c) => c.toggleItalic(),
  },
  { kind: "link", label: "Link", icon: Link01Icon },
  {
    kind: "format",
    label: "Checklist",
    icon: CheckListIcon,
    shortcut: "⌘⇧9",
    pressed: "taskList",
    command: (c) => c.toggleTaskList(),
  },
  {
    kind: "format",
    label: "Bulleted list",
    icon: LeftToRightListBulletIcon,
    shortcut: "⌘⇧8",
    pressed: "bulletList",
    command: (c) => c.toggleBulletList(),
  },
  {
    kind: "format",
    label: "Numbered list",
    icon: LeftToRightListNumberIcon,
    shortcut: "⌘⇧7",
    pressed: "orderedList",
    command: (c) => c.toggleOrderedList(),
  },
  {
    kind: "format",
    label: "Strikethrough",
    icon: TextStrikethroughIcon,
    shortcut: "⌘⇧S",
    pressed: "strike",
    command: (c) => c.toggleStrike(),
  },
  {
    kind: "format",
    label: "Inline code",
    icon: SourceCodeIcon,
    shortcut: "⌘E",
    pressed: "code",
    command: (c) => c.toggleCode(),
  },
  {
    kind: "format",
    label: "Quote",
    icon: QuoteDownIcon,
    shortcut: "⌘⇧B",
    pressed: "blockquote",
    command: (c) => c.toggleBlockquote(),
  },
  {
    kind: "format",
    label: "Code block",
    icon: CodeSquareIcon,
    shortcut: "⌘⌥C",
    pressed: "codeBlock",
    command: (c) => c.toggleCodeBlock(),
  },
  { kind: "table", label: "Table", icon: Table01Icon },
  { kind: "action", label: "Divider", icon: MinusSignIcon, command: (c) => c.setHorizontalRule() },
  {
    kind: "action",
    label: "Undo",
    icon: Undo02Icon,
    shortcut: "⌘Z",
    enabled: "canUndo",
    command: (c) => c.undo(),
  },
  {
    kind: "action",
    label: "Redo",
    icon: Redo02Icon,
    shortcut: "⌘⇧Z",
    enabled: "canRedo",
    command: (c) => c.redo(),
  },
];

/** How many controls fit beside the text style. */
const useFitting = (total: number) => {
  const row = useRef<HTMLDivElement>(null);
  const style = useRef<HTMLButtonElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setRoom((entry?.contentRect.width ?? 0) - (style.current?.offsetWidth ?? 0) - 2);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { row, style, fitting: fittingControls(room, total) };
};

/**
 * The document's formatting row. Every control is a command on the shared
 * tree, so what it does syncs like typing. It never wraps: what does not fit
 * the panel's width moves, last first, into a More menu.
 */
export function DocumentToolbar({ editor }: { editor: Editor }) {
  const state = useToolbarState(editor);
  const { row, style, fitting } = useFitting(CONTROLS.length);
  const [linkAnchor, setLinkAnchor] = useState<Element | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const shown = CONTROLS.slice(0, fitting);
  const folded = CONTROLS.slice(fitting);
  const block = BLOCKS.find((item) => item.value === state.block) ?? BLOCKS[0];

  const inRow = (control: Control): ReactNode => {
    switch (control.kind) {
      case "format":
        return (
          <Format
            key={control.label}
            icon={control.icon}
            label={control.label}
            shortcut={control.shortcut}
            pressed={Boolean(state[control.pressed])}
            onPress={() => run(editor, control.command)}
          />
        );
      case "action":
        return (
          <Action
            key={control.label}
            icon={control.icon}
            label={control.label}
            shortcut={control.shortcut}
            disabled={control.enabled ? !state[control.enabled] : false}
            onPress={() => run(editor, control.command)}
          />
        );
      case "link":
        return (
          <Format
            key="link"
            icon={Link01Icon}
            label="Link"
            pressed={state.link}
            onPress={setLinkAnchor}
          />
        );
      case "table":
        return <TableMenu key="table" editor={editor} inTable={state.table} />;
    }
  };

  const inMenu = (control: Control): ReactNode => {
    switch (control.kind) {
      case "format":
        return (
          <DropdownMenuCheckboxItem
            key={control.label}
            checked={Boolean(state[control.pressed])}
            onCheckedChange={() => run(editor, control.command)}
          >
            <HugeiconsIcon icon={control.icon} strokeWidth={2} />
            {control.label}
          </DropdownMenuCheckboxItem>
        );
      case "action":
        return (
          <DropdownMenuItem
            key={control.label}
            disabled={control.enabled ? !state[control.enabled] : false}
            onClick={() => run(editor, control.command)}
          >
            <HugeiconsIcon icon={control.icon} strokeWidth={2} />
            {control.label}
          </DropdownMenuItem>
        );
      case "link":
        return (
          <DropdownMenuItem
            key="link"
            // The menu hands focus back to its button as it closes; open after that.
            onClick={() => requestAnimationFrame(() => setLinkAnchor(more.current))}
          >
            <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
            Link…
          </DropdownMenuItem>
        );
      case "table":
        return state.table ? (
          <DropdownMenuSub key="table">
            <DropdownMenuSubTrigger>
              <HugeiconsIcon icon={Table01Icon} strokeWidth={2} />
              Table
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <TableItems editor={editor} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <InsertTableItem key="table" editor={editor} />
        );
    }
  };

  return (
    // One Tab stop for the whole row; arrow keys move between its controls.
    <Toolbar.Root
      ref={row}
      aria-label="Formatting"
      className="flex min-w-0 flex-1 items-center gap-0.5"
    >
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toolbar.Button
                render={
                  <DropdownMenuTrigger
                    render={
                      <Button
                        ref={style}
                        size="sm"
                        variant="ghost"
                        aria-label={`Text style: ${block.label}`}
                        className="text-muted-foreground"
                        onMouseDown={keepSelection}
                      />
                    }
                  />
                }
              />
            }
          >
            <HugeiconsIcon icon={block.icon} strokeWidth={2} />
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} data-icon="inline-end" />
          </TooltipTrigger>
          <Hint label="Text style" />
        </Tooltip>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuRadioGroup
            value={state.block}
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
      {shown.map(inRow)}
      {folded.length ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toolbar.Button
                  render={
                    <DropdownMenuTrigger
                      render={
                        <Button
                          ref={more}
                          size="icon-sm"
                          variant="ghost"
                          aria-label="More formatting"
                          className="text-muted-foreground"
                          onMouseDown={keepSelection}
                        />
                      }
                    />
                  }
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </TooltipTrigger>
            <Hint label="More formatting" />
          </Tooltip>
          <DropdownMenuContent align="end" className="w-52">
            {folded.map((control, index) => {
              const previous = folded[index - 1];
              // Undo and redo are about the document, not the selection.
              const divide = previous && control.label === "Undo";
              return divide
                ? [<DropdownMenuSeparator key="history" />, inMenu(control)]
                : inMenu(control);
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <LinkPopover editor={editor} anchor={linkAnchor} onClose={() => setLinkAnchor(null)} />
    </Toolbar.Root>
  );
}

function InsertTableItem({ editor }: { editor: Editor }) {
  return (
    <DropdownMenuItem
      onClick={() =>
        run(editor, (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))
      }
    >
      <HugeiconsIcon icon={Table01Icon} strokeWidth={2} />
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
          <HugeiconsIcon icon={Table01Icon} strokeWidth={2} />
        </TooltipTrigger>
        <Hint label="Table" />
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        {inTable ? <TableItems editor={editor} /> : <InsertTableItem editor={editor} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
