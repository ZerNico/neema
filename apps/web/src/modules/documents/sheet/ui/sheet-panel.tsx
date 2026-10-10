import {
  Add01Icon,
  ClipboardIcon,
  ColumnDeleteIcon,
  ColumnInsertIcon,
  Copy01Icon,
  Delete02Icon,
  RowDeleteIcon,
  RowInsertIcon,
  Scissor01Icon,
  SortingAZ01Icon,
  SortingZA01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { columnLetters } from "@chat/sheet/a1";
import { sheetLocale } from "@chat/sheet/locales";
import { NEW_SHEET, liveSheets, positions } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import {
  clearSelection,
  copySelection,
  deleteAtSelection,
  enterCell,
  fillSelection,
  formatSelection,
  insertAtSelection,
  pasteAtSelection,
  sortSelection,
  type CopiedCells,
  type GridContext,
} from "@chat/sheet-react/commands";
import { cellSource, cellStyle } from "@chat/sheet-react/display";
import {
  SheetGrid,
  type CellEditing,
  type GridCommand,
  type GridDecoration,
  type SheetSelection,
} from "@chat/sheet-react/grid";
import { Button } from "~/ui/primitives/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/ui/primitives/context-menu";
import { FieldError } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import type { SheetController } from "../client/use-sheet.ts";
import { useSheetValues } from "../client/use-sheet-values.ts";
import { SheetToolbar } from "./sheet-toolbar.tsx";

function MenuItem({
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

/** A name for a new sheet that no live sheet has: Sheet2, Sheet3 and on. */
const nextSheetName = (names: readonly string[]) => {
  const taken = new Set(names.map((name) => name.toLowerCase()));
  for (let n = names.length + 1; ; n++) if (!taken.has(`sheet${n}`)) return `Sheet${n}`;
};

/**
 * An open sheet: the formula bar, the grid and the sheet tabs, with the
 * formatting row in the panel's actions. Values are calculated here from the
 * document and the moment its revision carries, as every replica calculates
 * them; every edit goes through the connection, which shows it at once.
 */
export default function SheetPanelBody({
  controller,
  canEdit,
  toolbarSlot,
}: {
  controller: SheetController;
  canEdit: boolean;
  toolbarSlot: HTMLElement | null;
}) {
  const { state, sync } = controller;
  const doc = state?.doc ?? null;
  const [chosen, setChosen] = useState<string | null>(null);
  const [selection, setSelection] = useState<SheetSelection | null>(null);
  const [editing, setEditing] = useState<CellEditing | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const copied = useRef<CopiedCells | null>(null);
  const formulaBar = useRef<HTMLInputElement>(null);
  const sheets = useMemo(() => (doc ? liveSheets(doc) : []), [doc]);
  const sheet = chosen && sheets.includes(chosen) ? chosen : (sheets[0] ?? null);
  const revision = state?.revision ?? 0;
  const moment = state?.moment ?? null;
  const calcContext = useMemo(
    () => (moment ? { revision, epoch: 0, ...moment } : null),
    [revision, moment],
  );
  const values = useSheetValues(doc, calcContext);
  if (!doc || !values || !sheet || !state)
    return <Spinner aria-label="Connecting to sheet" className="text-muted-foreground" />;

  const readOnly = !canEdit || !sync || state.status === "gone";
  const locale = sheetLocale(doc.settings.locale);
  const rows = positions(doc.sheet[sheet]!.rows);
  const cols = positions(doc.sheet[sheet]!.cols);
  const first = { r: rows.ids[0]!, c: cols.ids[0]! };
  // A selection whose cells were deleted, or none yet, falls back to A1.
  const active: SheetSelection =
    selection &&
    rows.at(selection.head.r) !== undefined &&
    cols.at(selection.head.c) !== undefined &&
    rows.at(selection.anchor.r) !== undefined &&
    cols.at(selection.anchor.c) !== undefined
      ? selection
      : { anchor: first, head: first };
  const head = active.head;
  const source = cellSource(doc, sheet, head.r, head.c, locale);
  const style = cellStyle(doc.sheet[sheet]!.cells[head.r]?.[head.c]?.s);
  const context: GridContext = {
    doc,
    sheet,
    selection: active,
    values,
    locale,
    mint: () => sync!.mint(),
  };
  const run = (ops: readonly SheetOp[]) => {
    if (!readOnly && ops.length) sync!.dispatch(ops);
  };
  const select = (next: SheetSelection) => {
    setSelection(next);
    sync?.setCursor({ sheet, anchor: next.anchor, head: next.head });
  };
  const commit = (at: SheetSelection["head"], text: string) => {
    if (text !== cellSource(doc, sheet, at.r, at.c, locale)) run(enterCell(context, at, text));
  };
  const onCommand = (command: GridCommand) => {
    if (command.kind === "toggle")
      run(formatSelection(context, { [command.property]: style[command.property] ? null : true }));
    else if (command.kind === "fill") run(fillSelection(context, command.direction));
    else if (command.kind === "undo") sync?.undo();
    else if (command.kind === "redo") sync?.redo();
    else run(clearSelection(context));
  };
  const paste = (text: string) => {
    const from = copied.current;
    run(pasteAtSelection(context, text, from));
    // A cut moves once; pasting it again copies what now stands there.
    if (from?.cut && from.text === text) copied.current = null;
  };
  const decorations: GridDecoration[] = [...state.presence]
    .filter(([, presence]) => presence.sheet === sheet)
    .map(([clientId, presence]) => ({
      key: clientId,
      selection: { anchor: presence.anchor, head: presence.head },
      color: presence.user.color,
      label: presence.user.name,
    }));
  const address = `${columnLetters(cols.at(head.c)!)}${rows.at(head.r)}`;
  const barText =
    editing && editing.at.r === head.r && editing.at.c === head.c ? editing.text : source;

  return (
    // Pulled to the panel's edges, as the text editor is: the grid scrolls on its own.
    <div className="-m-4 flex min-h-48 min-w-0 flex-1 flex-col">
      {toolbarSlot
        ? createPortal(
            <SheetToolbar
              style={style}
              canUndo={state.canUndo}
              canRedo={state.canRedo}
              readOnly={readOnly}
              onUndo={() => sync?.undo()}
              onRedo={() => sync?.redo()}
              onFormat={(patch) => run(formatSelection(context, patch))}
            />,
            toolbarSlot,
          )
        : null}
      {state.refused ? <FieldError className="mx-3 mt-2">{state.refused}</FieldError> : null}
      <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-muted-foreground w-14 shrink-0 font-mono text-xs">{address}</span>
        <Input
          ref={formulaBar}
          aria-label="Formula bar"
          data-sheet-editor="true"
          readOnly={readOnly}
          value={barText}
          // oxlint-disable-next-line shadcn/no-restyle -- the formula bar sits flat in its row, as in a spreadsheet.
          className="h-7 border-0 font-mono text-xs shadow-none focus-visible:ring-0"
          onFocus={() => {
            if (!readOnly && !editing) setEditing({ at: head, text: source, mode: "edit" });
          }}
          onChange={(event) => setEditing({ at: head, text: event.target.value, mode: "edit" })}
          onKeyDown={(event) => {
            if (!editing) return;
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              commit(editing.at, editing.text);
              setEditing(null);
              formulaBar.current?.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(null);
              formulaBar.current?.blur();
            }
          }}
          onBlur={(event) => {
            if (!editing) return;
            // Into the cell's own editor, the edit carries on there.
            if (event.relatedTarget instanceof HTMLInputElement) return;
            commit(editing.at, editing.text);
            setEditing(null);
          }}
        />
      </div>
      <ContextMenu>
        <ContextMenuTrigger className="relative min-h-0 flex-1">
          <div className="absolute inset-0">
            <SheetGrid
              key={sheet}
              doc={doc}
              sheet={sheet}
              values={values}
              locale={locale}
              selection={active}
              onSelectionChange={select}
              label={doc.sheet[sheet]!.name}
              readOnly={readOnly}
              editing={editing}
              onEditingChange={setEditing}
              onCommit={commit}
              editSource={(at) => cellSource(doc, sheet, at.r, at.c, locale)}
              onCommand={onCommand}
              onCopy={(cut) => {
                copied.current = copySelection(context, cut);
                return copied.current.text;
              }}
              onPaste={paste}
              onResize={(axis, id, px) =>
                run([
                  {
                    op: "resize",
                    sh: sheet,
                    axis,
                    ids: [id],
                    // Stored as Excel keeps them: characters wide, points high.
                    size:
                      axis === "columns"
                        ? Math.max(0, Math.round(((px - 5) / 7) * 100) / 100)
                        : Math.round(((px * 3) / 4) * 100) / 100,
                  },
                ])
              }
              decorations={decorations}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <MenuItem
            icon={Scissor01Icon}
            label="Cut"
            disabled={readOnly}
            onClick={() => {
              copied.current = copySelection(context, true);
              void navigator.clipboard?.writeText(copied.current.text);
            }}
          />
          <MenuItem
            icon={Copy01Icon}
            label="Copy"
            onClick={() => {
              copied.current = copySelection(context, false);
              void navigator.clipboard?.writeText(copied.current.text);
            }}
          />
          <MenuItem
            icon={ClipboardIcon}
            label="Paste"
            disabled={readOnly}
            onClick={() => {
              void navigator.clipboard?.readText().then(paste);
            }}
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
        </ContextMenuContent>
      </ContextMenu>
      <div
        role="tablist"
        aria-label="Sheets"
        className="border-border flex shrink-0 items-center gap-1 overflow-x-auto border-t px-2 py-1"
      >
        {sheets.map((id) =>
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
            <ContextMenu key={id}>
              <ContextMenuTrigger
                render={
                  <Button
                    role="tab"
                    aria-selected={id === sheet}
                    size="xs"
                    variant={id === sheet ? "secondary" : "ghost"}
                    onClick={() => {
                      setChosen(id);
                      setSelection(null);
                      setEditing(null);
                    }}
                    onDoubleClick={() => {
                      if (!readOnly) setRenaming({ id, name: doc.sheet[id]!.name });
                    }}
                  />
                }
              >
                {doc.sheet[id]!.name}
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
                <ContextMenuItem
                  disabled={readOnly}
                  onClick={() => setRenaming({ id, name: doc.sheet[id]!.name })}
                >
                  Rename
                </ContextMenuItem>
                <ContextMenuItem
                  variant="destructive"
                  disabled={readOnly || sheets.length === 1}
                  onClick={() => run([{ op: "sheetDelete", id }])}
                >
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
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
                    const id = sync!.mint();
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
                    setChosen(id);
                    setSelection(null);
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
    </div>
  );
}
