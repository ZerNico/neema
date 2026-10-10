import {
  Add01Icon,
  ChartColumnIcon,
  CommentAdd01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
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
  chartFromSelection,
  type ChartKind,
  clearSelection,
  copySelection,
  deleteAtSelection,
  dragSelection,
  enterCell,
  enterSelection,
  fillFromHandle,
  fillSelection,
  formatSelection,
  insertAtSelection,
  pasteAtSelection,
  sortSelection,
  type CopiedCells,
  type GridContext,
} from "@chat/sheet-react/commands";
import { cellDisplay, cellSource, cellStyle } from "@chat/sheet-react/display";
import {
  SheetGrid,
  type CellEditing,
  type GridCommand,
  type GridDecoration,
  type GridFill,
  type GridOverlay,
  type SheetSelection,
} from "@chat/sheet-react/grid";
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
import { FieldError } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { uuidv7 } from "uuidv7";
import { toast } from "sonner";
import { toastError } from "~/ui/error-toast.ts";
import { commentMessage } from "../../comment-message.ts";
import {
  commentOnDocument,
  deleteDocumentComment,
  resolveDocumentThread,
} from "../../server/document-functions.ts";
import type { ThreadActions } from "../../ui/comment-actions.ts";
import { CommentInput, CommentThread } from "../../ui/comment-thread.tsx";
import type { AskTarget } from "../../ui/rich-editor/editor-hooks.ts";
import type { SheetController } from "../client/use-sheet.ts";
import { useSheetValues } from "../client/use-sheet-values.ts";
import { SheetToolbar } from "./sheet-toolbar.tsx";
import { CHART_KINDS } from "./chart-kinds.ts";
import { CHART_LIMITS, chartData } from "@chat/sheet/model/chart";
import { ChartEditor } from "./chart-editor/chart-editor.tsx";
import { FillOptions, type FillChoice } from "./fill-options.tsx";
import { SheetChart } from "./sheet-chart.tsx";
import { ChartContextItems, ChartMenuButton } from "./sheet-charts.tsx";
import { chartDecorations, chartImage, duplicateChart, type ChartAction } from "./chart-actions.ts";

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

const sameSelection = (a: SheetSelection, b: SheetSelection) =>
  a.anchor.r === b.anchor.r &&
  a.anchor.c === b.anchor.c &&
  a.head.r === b.head.r &&
  a.head.c === b.head.c;

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
  me = null,
  ask = null,
}: {
  controller: SheetController;
  canEdit: boolean;
  toolbarSlot: HTMLElement | null;
  /** The reader's account, to tell their own comments apart. */
  me?: string | null;
  /** Sends a comment to the assistant as a chat message about its cell. */
  ask?: ((request: string, target: AskTarget) => Promise<boolean>) | null;
}) {
  const { state, sync } = controller;
  const doc = state?.doc ?? null;
  const [chosen, setChosen] = useState<string | null>(null);
  const [selection, setSelection] = useState<SheetSelection | null>(null);
  const [editing, setEditing] = useState<CellEditing | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // Writing a new thread on the active cell.
  const [commenting, setCommenting] = useState(false);
  // What Find looks for, and which match is current; null while the bar is closed.
  const [finding, setFinding] = useState<{ query: string; index: number } | null>(null);
  // A chart selected instead of cells, and the chart open in the editor, by ID.
  const [chartPicked, setChartPicked] = useState<string | null>(null);
  const [chartEditing, setChartEditing] = useState<string | null>(null);
  /** The fill just made, which Auto Fill Options can redo another way while it stays selected. */
  const [lastFill, setLastFill] = useState<{
    source: SheetSelection;
    fill: GridFill & { count: number };
    result: SheetSelection;
    choice: FillChoice | null;
  } | null>(null);
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
  const comments = state.comments;
  const roots = comments.filter((each) => each.id === each.threadId);
  /** Threads whose cell is on this sheet, by where they sit. */
  const placed = roots.flatMap((root) => {
    const at = doc.anchors[root.id];
    return at && at.sh === sheet && rows.at(at.r) !== undefined && cols.at(at.c) !== undefined
      ? [{ root, at }]
      : [];
  });
  const here = placed.filter(({ at }) => at.r === head.r && at.c === head.c);
  const shownThread = here.find(({ root }) => !root.resolvedAt) ?? here[0] ?? null;
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
    if (next.head.r !== active.head.r || next.head.c !== active.head.c) setCommenting(false);
    setSelection(next);
    sync?.setCursor({ sheet, anchor: next.anchor, head: next.head });
  };
  const commit = (at: SheetSelection["head"], text: string) => {
    if (text !== cellSource(doc, sheet, at.r, at.c, locale)) run(enterCell(context, at, text));
  };
  // Cells whose shown text or formula holds the query, in reading order.
  const matches = (() => {
    const query = finding?.query.trim().toLowerCase();
    if (!query) return [];
    const found: Array<{ r: string; c: string; row: number; col: number }> = [];
    for (const [r, row] of Object.entries(doc.sheet[sheet]!.cells)) {
      const rowAt = rows.at(r);
      if (rowAt === undefined) continue;
      for (const [c, cell] of Object.entries(row)) {
        const colAt = cols.at(c);
        if (colAt === undefined) continue;
        const shown = cellDisplay(values.value(sheet, r, c), cellStyle(cell.s), locale).text;
        const formula = cell.f ? cellSource(doc, sheet, r, c, locale) : "";
        if (shown.toLowerCase().includes(query) || formula.toLowerCase().includes(query))
          found.push({ r, c, row: rowAt, col: colAt });
      }
    }
    return found.toSorted((a, b) => a.row - b.row || a.col - b.col);
  })();
  const goTo = (index: number) => {
    if (!finding || !matches.length) return;
    const next = ((index % matches.length) + matches.length) % matches.length;
    setFinding({ ...finding, index: next });
    const at = { r: matches[next]!.r, c: matches[next]!.c };
    select({ anchor: at, head: at });
  };
  const onCommand = (command: GridCommand) => {
    if (command.kind === "find") setFinding({ query: finding?.query ?? "", index: 0 });
    else if (command.kind === "toggle")
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
  const decorations: GridDecoration[] = [
    // A corner mark on each open thread's cell.
    ...placed
      .filter(({ root }) => !root.resolvedAt)
      .map(({ root, at }) => ({
        key: `thread:${root.id}`,
        selection: { anchor: at, head: at },
        color: "var(--warning)",
        marker: true,
      })),
    // Find's matches, a few hundred at most, outlined without a name.
    ...matches.slice(0, 500).map((match) => ({
      key: `find:${match.r}:${match.c}`,
      selection: { anchor: match, head: match },
      color: "var(--ring)",
    })),
    ...[...state.presence]
      .filter(([, presence]) => presence.sheet === sheet)
      .map(([clientId, presence]) => ({
        key: clientId,
        selection: { anchor: presence.anchor, head: presence.head },
        color: presence.user.color,
        label: presence.user.name,
      })),
  ];
  const address = `${columnLetters(cols.at(head.c)!)}${rows.at(head.r)}`;
  const editedChart = chartEditing ? doc.charts[chartEditing] : undefined;
  // The selection as a range by IDs, corners in order.
  const selectedBox = (() => {
    const [r1, r2] = [rows.at(active.anchor.r)!, rows.at(active.head.r)!];
    const [c1, c2] = [cols.at(active.anchor.c)!, cols.at(active.head.c)!];
    return {
      r1: rows.ids[Math.min(r1, r2) - 1]!,
      r2: rows.ids[Math.max(r1, r2) - 1]!,
      c1: cols.ids[Math.min(c1, c2) - 1]!,
      c2: cols.ids[Math.max(c1, c2) - 1]!,
    };
  })();
  const pickedChart = chartPicked && doc.charts[chartPicked]?.sheet === sheet ? chartPicked : null;
  if (pickedChart) decorations.push(...chartDecorations(doc.charts[pickedChart]!, sheet));
  const insertChart = (kind: ChartKind) => {
    const ops = chartFromSelection(context, kind);
    if (!ops.length) {
      toast("Select the cells to chart first", {
        description: "A header row and label column are picked up.",
      });
      return;
    }
    run(ops);
    const added = ops.find((op) => op.op === "chartPut");
    if (added && !readOnly) {
      setChartPicked(added.id);
      setChartEditing(added.id);
    }
  };
  const chartAction = (id: string, action: ChartAction) => {
    const chart = doc.charts[id];
    if (!chart) return;
    if (action === "edit") setChartEditing(id);
    else if (action === "delete") {
      run([{ op: "chartDelete", id }]);
      setChartPicked(null);
      if (chartEditing === id) setChartEditing(null);
    } else if (action === "duplicate") {
      const copy = sync!.mint();
      run([duplicateChart(doc, chart, copy)]);
      setChartPicked(copy);
    } else void chartImage(id, chartData(doc, values, chart).title, action);
  };
  const overlays: GridOverlay[] = Object.entries(doc.charts)
    .filter(([, chart]) => chart.sheet === sheet)
    .map(([id, chart]) => {
      const data = chartData(doc, values, chart);
      return {
        key: id,
        at: chart.at,
        width: chart.size.width,
        height: chart.size.height,
        label: data.title ? `Chart: ${data.title}` : "Chart",
        min: { width: CHART_LIMITS.width.min, height: CHART_LIMITS.height.min },
        content: (
          <div className="group relative h-full">
            <SheetChart id={id} chart={chart} data={data} locale={locale} />
            <div className="absolute top-2 right-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
              <ChartMenuButton readOnly={readOnly} onAction={(action) => chartAction(id, action)} />
            </div>
          </div>
        ),
      };
    });
  const cellOf = (at: { r: string; c: string }) => [sheet, at.r, at.c, at.r, at.c];
  const sendToAssistant = async (
    thread: string,
    quote: string,
    body: string,
    at: { r: string; c: string },
  ) => {
    const sent = await ask?.(commentMessage(quote, body), { blocks: cellOf(at), thread }).catch(
      () => false,
    );
    if (!sent) toastError("Couldn’t send it to the assistant", null);
  };
  const threadActions = (at: { r: string; c: string }): ThreadActions | null =>
    readOnly
      ? null
      : {
          canAsk: ask !== null,
          reply: async (threadId, quote, body, toAssistant) => {
            try {
              await commentOnDocument({
                data: { documentId: controller.documentId, threadId, body, toAssistant },
              });
            } catch (error) {
              toastError("Couldn’t send the reply.", error);
              return;
            }
            if (toAssistant) await sendToAssistant(threadId, quote, body, at);
          },
          resolve: (threadId, resolved) =>
            resolveDocumentThread({
              data: { documentId: controller.documentId, threadId, resolved },
            }).catch((error: unknown) => toastError("Couldn’t update the thread.", error)),
          remove: (commentId) =>
            deleteDocumentComment({ data: { documentId: controller.documentId, commentId } }).catch(
              (error: unknown) => toastError("Couldn’t delete the comment.", error),
            ),
        };
  const startThread = async (body: string, toAssistant: boolean) => {
    const threadId = uuidv7();
    const shown = cellDisplay(values.value(sheet, head.r, head.c), style, locale).text;
    const quote = `${address}${shown ? ` · ${shown}` : ""}`.slice(0, 500);
    const at = { r: head.r, c: head.c };
    try {
      await commentOnDocument({
        data: {
          documentId: controller.documentId,
          threadId,
          body,
          quote,
          toAssistant,
          cell: { sh: sheet, ...at },
        },
      });
    } catch (error) {
      toastError("Couldn’t add the comment.", error);
      return;
    }
    setCommenting(false);
    if (toAssistant) await sendToAssistant(threadId, quote, body, at);
  };
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
              onChart={insertChart}
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
      {shownThread || commenting ? (
        <div className="border-border max-h-64 shrink-0 overflow-y-auto border-b p-3">
          {shownThread ? (
            <CommentThread
              root={shownThread.root}
              replies={comments.filter(
                (each) => each.threadId === shownThread.root.id && each.id !== shownThread.root.id,
              )}
              anchored
              me={me}
              actions={threadActions(shownThread.at)}
              expanded
            />
          ) : (
            <CommentInput
              placeholder={`Comment on ${address}`}
              canAsk={ask !== null}
              autoFocus
              onSubmit={startThread}
            />
          )}
        </div>
      ) : null}
      {finding ? (
        <div className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-3">
          <Input
            autoFocus
            aria-label="Find in sheet"
            placeholder="Find in sheet"
            value={finding.query}
            // oxlint-disable-next-line shadcn/no-restyle -- sits flat in its row, as the formula bar does.
            className="h-7 border-0 text-xs shadow-none focus-visible:ring-0"
            onChange={(event) => setFinding({ query: event.target.value, index: 0 })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goTo(finding.index + (event.shiftKey ? -1 : 1));
              } else if (event.key === "Escape") {
                event.preventDefault();
                setFinding(null);
              }
            }}
          />
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {finding.query.trim()
              ? matches.length
                ? `${Math.min(finding.index, matches.length - 1) + 1} of ${matches.length}`
                : "No matches"
              : ""}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous match"
            disabled={!matches.length}
            onClick={() => goTo(finding.index - 1)}
          >
            <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next match"
            disabled={!matches.length}
            onClick={() => goTo(finding.index + 1)}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Close find"
            onClick={() => setFinding(null)}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <ContextMenu>
          <ContextMenuTrigger className="relative min-h-0 min-w-0 flex-1">
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
                onCommitSelection={(text) => run(enterSelection(context, text))}
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
                overlays={overlays}
                selectedOverlay={pickedChart}
                onOverlaySelect={setChartPicked}
                onOverlayChange={(id, change) =>
                  run([
                    {
                      op: "chartPatch",
                      id,
                      patch: {
                        at: change.at,
                        size: {
                          width: Math.min(CHART_LIMITS.width.max, change.width),
                          height: Math.min(CHART_LIMITS.height.max, change.height),
                        },
                      },
                    },
                  ])
                }
                onOverlayCommand={chartAction}
                onDragSelection={(shift, copy) => {
                  const result = dragSelection(context, shift, copy);
                  if (!result || readOnly) return;
                  run(result.ops);
                  select(result.selection);
                }}
                onFill={(fill) => {
                  const result = fillFromHandle(context, fill);
                  if (!result || readOnly) return;
                  run(result.ops);
                  select(result.selection);
                  setLastFill(
                    result.count > 0
                      ? {
                          source: active,
                          fill: { ...fill, count: result.count },
                          result: result.selection,
                          choice: null,
                        }
                      : null,
                  );
                }}
                selectionAccessory={
                  lastFill && !readOnly && sameSelection(lastFill.result, active) ? (
                    <FillOptions
                      chosen={lastFill.choice}
                      onChoose={(choice) => {
                        // Taken back, then made again the chosen way, as one more change.
                        sync!.undo();
                        const undone = sync!.getState().doc;
                        if (!undone) return;
                        const again = fillFromHandle(
                          { ...context, doc: undone, selection: lastFill.source },
                          {
                            ...lastFill.fill,
                            mode:
                              choice === "copy" ? "copy" : choice === "series" ? "series" : "auto",
                          },
                          choice === "formats" ? "formats" : choice === "values" ? "values" : "all",
                        );
                        if (!again) return;
                        run(again.ops);
                        select(again.selection);
                        setLastFill({ ...lastFill, result: again.selection, choice });
                      }}
                    />
                  ) : null
                }
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            {pickedChart ? (
              <ChartContextItems
                readOnly={readOnly}
                onAction={(action) => chartAction(pickedChart, action)}
              />
            ) : (
              <>
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
                <MenuItem
                  icon={CommentAdd01Icon}
                  label="Comment"
                  disabled={readOnly || !!shownThread}
                  onClick={() => setCommenting(true)}
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
                    <HugeiconsIcon icon={ChartColumnIcon} strokeWidth={2} />
                    Insert chart
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-40">
                    {CHART_KINDS.map((each) => (
                      <ContextMenuItem key={each.kind} onClick={() => insertChart(each.kind)}>
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
            )}
          </ContextMenuContent>
        </ContextMenu>
        {editedChart ? (
          <ChartEditor
            key={chartEditing}
            doc={doc}
            values={values}
            chart={editedChart}
            readOnly={readOnly}
            selection={{ sheet, box: selectedBox }}
            patch={(patch) => run([{ op: "chartPatch", id: chartEditing!, patch }])}
            onClose={() => setChartEditing(null)}
          />
        ) : null}
      </div>
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
