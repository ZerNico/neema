import {
  ChartColumnIcon,
  ClipboardIcon,
  ColumnDeleteIcon,
  ColumnInsertIcon,
  CommentAdd01Icon,
  Copy01Icon,
  Delete02Icon,
  Link01Icon,
  RowDeleteIcon,
  RowInsertIcon,
  Scissor01Icon,
  SortingAZ01Icon,
  SortingZA01Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import type { SheetOp } from "@chat/sheet/model/ops";
import {
  clearSelection,
  deleteAtSelection,
  hideAtSelection,
  insertAtSelection,
  sortSelection,
  type ChartKind,
  type GridContext,
  type PastePart,
} from "@chat/sheet-react/commands";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "~/ui/primitives/context-menu";
import { CHART_KINDS } from "./chart-kinds.ts";

export function MenuItem({
  icon,
  label,
  disabled = false,
  onClick,
}: {
  icon: HugeiconsIconProps["icon"];
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <ContextMenuItem disabled={disabled} onClick={onClick}>
      <HugeiconsIcon icon={icon} strokeWidth={2} />
      {label}
    </ContextMenuItem>
  );
}

/** Excel's Paste Special choices, as the cell menu offers them. */
const PASTE_SPECIAL: ReadonlyArray<{
  label: string;
  options: { part?: PastePart; transpose?: boolean };
}> = [
  { label: "Values only", options: { part: "values" } },
  { label: "Formulas only", options: { part: "formulas" } },
  { label: "Formats only", options: { part: "formats" } },
  { label: "Transposed", options: { transpose: true } },
];

/** The cell menu: the clipboard, comments and links, rows and columns, charts, sorting, clearing. */
export function CellMenuItems({
  readOnly,
  linked,
  context,
  run,
  onCopy,
  onPaste,
  onComment,
  onLink,
  onChart,
}: {
  readOnly: boolean;
  /** Whether the active cell has a link, which the link item then edits. */
  linked: boolean;
  context: GridContext;
  run: (ops: readonly SheetOp[]) => void;
  onCopy: (cut: boolean) => void;
  onPaste: (options?: { part?: PastePart; transpose?: boolean }) => void;
  onComment: () => void;
  onLink: () => void;
  onChart: (kind: ChartKind) => void;
}) {
  return (
    <>
      <MenuItem icon={Scissor01Icon} label="Cut" disabled={readOnly} onClick={() => onCopy(true)} />
      <MenuItem icon={Copy01Icon} label="Copy" onClick={() => onCopy(false)} />
      <MenuItem icon={ClipboardIcon} label="Paste" disabled={readOnly} onClick={() => onPaste()} />
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={readOnly}>
          <HugeiconsIcon icon={ClipboardIcon} strokeWidth={2} />
          Paste special
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-44">
          {PASTE_SPECIAL.map((each) => (
            <MenuItem
              key={each.label}
              icon={ClipboardIcon}
              label={each.label}
              onClick={() => onPaste(each.options)}
            />
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <MenuItem icon={CommentAdd01Icon} label="Comment" disabled={readOnly} onClick={onComment} />
      <MenuItem
        icon={Link01Icon}
        label={linked ? "Edit link" : "Insert link"}
        disabled={readOnly}
        onClick={onLink}
      />
      <ContextMenuSeparator />
      <MenuItem
        icon={RowInsertIcon}
        label="Insert rows above"
        disabled={readOnly}
        onClick={() => run(insertAtSelection(context, "rows", "before"))}
      />
      <MenuItem
        icon={RowInsertIcon}
        label="Insert rows below"
        disabled={readOnly}
        onClick={() => run(insertAtSelection(context, "rows", "after"))}
      />
      <MenuItem
        icon={ColumnInsertIcon}
        label="Insert columns left"
        disabled={readOnly}
        onClick={() => run(insertAtSelection(context, "columns", "before"))}
      />
      <MenuItem
        icon={ColumnInsertIcon}
        label="Insert columns right"
        disabled={readOnly}
        onClick={() => run(insertAtSelection(context, "columns", "after"))}
      />
      <MenuItem
        icon={RowDeleteIcon}
        label="Delete rows"
        disabled={readOnly}
        onClick={() => run(deleteAtSelection(context, "rows"))}
      />
      <MenuItem
        icon={ColumnDeleteIcon}
        label="Delete columns"
        disabled={readOnly}
        onClick={() => run(deleteAtSelection(context, "columns"))}
      />
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={readOnly}>
          <HugeiconsIcon icon={ViewOffIcon} strokeWidth={2} />
          Hide and unhide
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-44">
          <MenuItem
            icon={ViewOffIcon}
            label="Hide rows"
            onClick={() => run(hideAtSelection(context, "rows", true))}
          />
          <MenuItem
            icon={ViewOffIcon}
            label="Hide columns"
            onClick={() => run(hideAtSelection(context, "columns", true))}
          />
          <MenuItem
            icon={ViewIcon}
            label="Unhide rows"
            onClick={() => run(hideAtSelection(context, "rows", false))}
          />
          <MenuItem
            icon={ViewIcon}
            label="Unhide columns"
            onClick={() => run(hideAtSelection(context, "columns", false))}
          />
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={readOnly}>
          <HugeiconsIcon icon={ChartColumnIcon} strokeWidth={2} />
          Insert chart
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-40">
          {CHART_KINDS.map((each) => (
            <ContextMenuItem key={each.kind} onClick={() => onChart(each.kind)}>
              {each.label}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <MenuItem
        icon={SortingAZ01Icon}
        label="Sort A to Z"
        disabled={readOnly}
        onClick={() => run(sortSelection(context, false))}
      />
      <MenuItem
        icon={SortingZA01Icon}
        label="Sort Z to A"
        disabled={readOnly}
        onClick={() => run(sortSelection(context, true))}
      />
      <MenuItem
        icon={Delete02Icon}
        label="Clear contents"
        disabled={readOnly}
        onClick={() => run(clearSelection(context))}
      />
    </>
  );
}
