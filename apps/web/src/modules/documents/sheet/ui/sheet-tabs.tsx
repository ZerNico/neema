import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import {
  Add01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Download04Icon,
  PaintBucketIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { NEW_SHEET, liveSheets, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import { Button } from "~/ui/primitives/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "~/ui/primitives/context-menu";
import { Input } from "~/ui/primitives/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { ColorSwatches } from "./toolbar-controls.tsx";

// Along the strip only, and never past either end of it.
const MODIFIERS = [
  RestrictToHorizontalAxis,
  RestrictToElement.configure({
    element: (operation) => operation.source?.element?.closest("[role=tablist]") ?? null,
  }),
];

/** A name for a new sheet that no live sheet has: Sheet2, Sheet3 and on. */
const nextSheetName = (names: readonly string[]) => {
  const taken = new Set(names.map((name) => name.toLowerCase()));
  for (let n = names.length + 1; ; n++) if (!taken.has(`sheet${n}`)) return `Sheet${n}`;
};

/** The op moving a sheet to a place among the others, as `sheetMove` names the one before it. */
function moveSheetTo(doc: SheetDoc, id: string, index: number): SheetOp | null {
  const order = liveSheets(doc);
  const from = order.indexOf(id);
  if (from === -1 || from === index) return null;
  const rest = order.filter((each) => each !== id);
  return { op: "sheetMove", id, after: index === 0 ? null : (rest[index - 1] ?? null) };
}

/**
 * The sheet tabs under the grid, as Excel's: pick one, drag to reorder,
 * double-click to rename, and a menu to colour, move, download or delete.
 */
export function SheetTabs({
  doc,
  current,
  readOnly,
  mint,
  run,
  onPick,
  onDownload,
}: {
  doc: SheetDoc;
  current: string;
  readOnly: boolean;
  mint: () => string;
  run: (ops: SheetOp[]) => void;
  onPick: (id: string) => void;
  /** Saves a sheet as CSV. */
  onDownload: (id: string) => void;
}) {
  const sheets = liveSheets(doc);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const move = (id: string, index: number) => {
    const op = moveSheetTo(doc, id, index);
    if (op) run([op]);
  };
  return (
    <DragDropProvider
      modifiers={MODIFIERS}
      onDragEnd={(event) => {
        const { source } = event.operation;
        if (event.canceled || !isSortable(source) || readOnly) return;
        if (source.index !== source.initialIndex) move(String(source.id), source.index);
      }}
    >
      <div
        role="tablist"
        aria-label="Sheets"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1"
      >
        {sheets.map((id, index) =>
          renaming?.id === id ? (
            <Input
              key={id}
              autoFocus
              aria-label="Sheet name"
              value={renaming.name}
              maxLength={31}
              // oxlint-disable-next-line shadcn/no-restyle -- sized to stand in for the tab it renames.
              className="h-6 w-32 text-xs"
              onChange={(event) => setRenaming({ id, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRenaming(null);
                if (event.key !== "Enter") return;
                const name = renaming.name.trim();
                if (name && name !== doc.sheet[id]!.name) run([{ op: "sheetRename", id, name }]);
                setRenaming(null);
              }}
              onBlur={() => setRenaming(null)}
            />
          ) : (
            <SheetTab
              key={id}
              id={id}
              index={index}
              name={doc.sheet[id]!.name}
              color={doc.sheet[id]!.color}
              selected={id === current}
              readOnly={readOnly}
              last={index === sheets.length - 1}
              only={sheets.length === 1}
              onPick={() => onPick(id)}
              onRename={() => setRenaming({ id, name: doc.sheet[id]!.name })}
              onColor={(color) => run([{ op: "sheetColor", id, color }])}
              onMove={(to) => move(id, to)}
              onDownload={() => onDownload(id)}
              onDelete={() => run([{ op: "sheetDelete", id }])}
            />
          ),
        )}
        {readOnly ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Add sheet"
                  className="text-muted-foreground"
                  onClick={() => {
                    const id = mint();
                    run([
                      {
                        op: "sheetAdd",
                        id,
                        name: nextSheetName(sheets.map((each) => doc.sheet[each]!.name)),
                        after: sheets.at(-1) ?? null,
                        rows: Array.from({ length: NEW_SHEET.rows }, (_, n) => `${id}.r${n + 1}`),
                        cols: Array.from({ length: NEW_SHEET.cols }, (_, n) => `${id}.c${n + 1}`),
                      },
                    ]);
                    onPick(id);
                  }}
                />
              }
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>Add sheet</TooltipContent>
          </Tooltip>
        )}
      </div>
    </DragDropProvider>
  );
}

function SheetTab({
  id,
  index,
  name,
  color,
  selected,
  readOnly,
  last,
  only,
  onPick,
  onRename,
  onColor,
  onMove,
  onDownload,
  onDelete,
}: {
  id: string;
  index: number;
  name: string;
  color: string | undefined;
  selected: boolean;
  readOnly: boolean;
  last: boolean;
  only: boolean;
  onPick: () => void;
  onRename: () => void;
  onColor: (color: string | null) => void;
  onMove: (index: number) => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const { ref } = useSortable({ id, index, disabled: readOnly });
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <Button
            ref={ref}
            role="tab"
            aria-selected={selected}
            size="xs"
            variant={selected ? "secondary" : "ghost"}
            className="relative"
            onClick={onPick}
            onDoubleClick={() => {
              if (!readOnly) onRename();
            }}
          />
        }
      >
        {name}
        {color ? (
          <span
            aria-hidden
            className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full"
            // The tab's colour is the sheet's data, as Excel keeps it.
            style={{ backgroundColor: color }}
          />
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem disabled={readOnly} onClick={onRename}>
          <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
          Rename
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={readOnly}>
            <HugeiconsIcon icon={PaintBucketIcon} strokeWidth={2} />
            Tab colour
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-64">
            <div className="p-2">
              <ColorSwatches value={color} resetLabel="No colour" onChange={onColor} />
            </div>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem disabled={readOnly || index === 0} onClick={() => onMove(index - 1)}>
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          Move left
        </ContextMenuItem>
        <ContextMenuItem disabled={readOnly || last} onClick={() => onMove(index + 1)}>
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
          Move right
        </ContextMenuItem>
        <ContextMenuItem onClick={onDownload}>
          <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
          Download as CSV
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" disabled={readOnly || only} onClick={onDelete}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
