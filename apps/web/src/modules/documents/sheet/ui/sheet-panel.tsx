import { cellStyle } from "@chat/sheet/model/style";
import { CommentAdd01Icon, Copy01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { columnLetters } from "@chat/sheet/a1";
import { sheetLocale } from "@chat/sheet/locales";
import { NEW_SHEET, liveSheets, positions, type CellAnchor } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import {
  chartFromSelection,
  type ChartKind,
  clearSelection,
  copySelection,
  deleteAtSelection,
  dragOverwrites,
  dragSelection,
  enterCell,
  hideAtSelection,
  enterSelection,
  fillFromHandle,
  fillSelection,
  formatSelection,
  insertAtSelection,
  newSheet,
  pasteAtSelection,
  selectionBox,
  eachRange,
  sheetCsv,
  type PastePart,
  type CopiedCells,
  type GridContext,
} from "@chat/sheet-react/commands";
import { cellDisplay, cellSource, safeLink } from "@chat/sheet-react/display";
import {
  SheetGrid,
  type CellEditing,
  type GridCommand,
  type GridDecoration,
  type GridFill,
  type GridOverlay,
  type OverlayCommand,
  type SheetGridProps,
  type SheetSelection,
} from "@chat/sheet-react/grid";
import { Button } from "~/ui/primitives/button";
import { readHtmlTable, selectionHtml } from "@chat/sheet-react/clipboard";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "~/ui/primitives/context-menu";
import { FieldError } from "~/ui/primitives/field";
import { Popover, PopoverContent } from "~/ui/primitives/popover";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { uuidv7 } from "uuidv7";
import { toast } from "sonner";
import { ConfirmContext } from "~/ui/confirm-context.ts";
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
import { SheetToolbar, type ToolbarCommand } from "./sheet-toolbar.tsx";
import { SheetTabs } from "./sheet-tabs.tsx";
import { CellMenuItems, MenuItem } from "./cell-menu.tsx";
import { FindBar } from "./find-bar.tsx";
import { findMatches } from "./find.ts";
import { FormulaBar } from "./formula-bar.tsx";
import { IMAGE_LIMITS } from "@chat/sheet/model/image";
import { pictureOf } from "./picture.ts";
import { PivotDialog, type PivotDraft } from "./pivot-dialog.tsx";
import { pivotFormula } from "./pivot.ts";
import { printHtml } from "@chat/sheet-react/print";
import {
  groupSelection,
  outlineAxis,
  showLevel,
  toggleGroup,
  ungroupSelection,
} from "@chat/sheet-react/outline-commands";
import { SheetZoom } from "./sheet-zoom.tsx";
import { useSheetZoom } from "./zoom.ts";
import { LinkChip, LinkDialog } from "./link-dialog.tsx";
import {
  addConditional,
  autoSum,
  borderSelection,
  clearConditional,
  editConditional,
  setValidation,
  clearSelectionAs,
  decimalsSelection,
  freezeAt,
  mergeSelection,
  selectionStats,
  shortcutFormat,
} from "@chat/sheet-react/format-commands";
import { formatValue, generalText } from "@chat/sheet/number-format";
import { CHART_LIMITS, chartData } from "@chat/sheet/model/chart";
import { ChartEditor } from "./chart-editor/chart-editor.tsx";
import { FillOptions, type FillChoice } from "./fill-options.tsx";
import { SheetChart } from "./sheet-chart.tsx";
import { SheetCommentsList } from "./sheet-comments.tsx";
import { FilterMenu } from "./filter-menu.tsx";
import { SortDialog } from "./sort-dialog.tsx";
import {
  filterChoices,
  setFilterRule,
  sortFilter,
  sortSelectionBy,
  toggleFilter,
} from "@chat/sheet-react/filter-commands";
import { filterSpan, filteredRows } from "@chat/sheet/model/filter";
import { conditionalLooks } from "@chat/sheet/model/conditional";
import { ConditionalMenu } from "./conditional-menu.tsx";
import { ValidationDialog } from "./validation-dialog.tsx";
import { rangeText, readRange } from "./chart-editor/ranges.ts";
import { allowed, invalidCells, listChoices, validationAt } from "@chat/sheet/model/validation";
import { shownText } from "@chat/sheet/model/filter";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { parseTyped } from "@chat/sheet/value-parse";
import { ChartContextItems, ChartMenuButton } from "./sheet-charts.tsx";
import { chartDecorations, chartImage, duplicateChart, type ChartAction } from "./chart-actions.ts";

/** Text and HTML on the clipboard from a menu, text alone where the browser has no ClipboardItem. */
function writeClipboard(text: string, html: string) {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  if (typeof ClipboardItem === "undefined") {
    void clipboard.writeText(text);
    return;
  }
  void clipboard
    .write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ])
    .catch(() => clipboard.writeText(text));
}

/** A chart or picture over the cells, as one is selected and acted on. */
type Picked = { readonly kind: "chart" | "image"; readonly id: string };
/** The grid knows overlays by one string key; only these two read and write it. */
const overlayKey = (picked: Picked) => `${picked.kind}:${picked.id}`;
const pickedOf = (key: string): Picked =>
  key.startsWith("image:")
    ? { kind: "image", id: key.slice("image:".length) }
    : { kind: "chart", id: key.slice("chart:".length) };

const NO_ROWS: ReadonlySet<string> = new Set();
const NO_LOOKS: ReturnType<typeof conditionalLooks> = new Map();

const sameSelection = (a: SheetSelection, b: SheetSelection) =>
  a.anchor.r === b.anchor.r &&
  a.anchor.c === b.anchor.c &&
  a.head.r === b.head.r &&
  a.head.c === b.head.c;

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
  menu = null,
  me = null,
  ask = null,
}: {
  controller: SheetController;
  canEdit: boolean;
  toolbarSlot: HTMLElement | null;
  /** The sheet's menu, drawn after the comment buttons. */
  menu?: ReactNode;
  /** The reader's account, to tell their own comments apart. */
  me?: string | null;
  /** Sends a comment to the assistant as a chat message about its cell. */
  ask?: ((request: string, target: AskTarget) => Promise<boolean>) | null;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const sync = controller.sync();
  const doc = state?.doc ?? null;
  const [chosen, setChosen] = useState<string | null>(null);
  const [selection, setSelection] = useState<SheetSelection | null>(null);
  const [editing, setEditing] = useState<CellEditing | null>(null);
  // Writing a new thread on the active cell.
  const [commenting, setCommenting] = useState(false);
  // A thread whose card was closed stays closed until the selection moves.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A filter button's open menu, and whether the Sort dialog is open.
  const [filterMenu, setFilterMenu] = useState<{ col: string; anchor: HTMLElement } | null>(null);
  const [sorting, setSorting] = useState(false);
  // The Data Validation dialog, and whether cells breaking their rules are circled.
  const [validating, setValidating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [pivoting, setPivoting] = useState(false);
  const [circling, setCircling] = useState(false);
  // The grid's box, which the comment card is placed against and follows the scrolling of.
  const [gridHost, setGridHost] = useState<HTMLDivElement | null>(null);
  const [cardAnchor, setCardAnchor] = useState<HTMLElement | null>(null);
  const [zoom, setZoom] = useSheetZoom(gridHost);
  // What Find looks for, and which match is current; null while the bar is closed.
  const [finding, setFinding] = useState<{ query: string; index: number } | null>(null);
  // A chart selected instead of cells, and the chart open in the editor, by ID.
  const [picked, setPicked] = useState<Picked | null>(null);
  const [chartEditing, setChartEditing] = useState<string | null>(null);
  // Absent outside the app's provider, as in tests, where a drop then replaces without asking.
  const confirm = useContext(ConfirmContext);
  /** The fill just made, which Auto Fill Options can redo another way while it stays selected. */
  const [lastFill, setLastFill] = useState<{
    source: SheetSelection;
    fill: GridFill & { count: number };
    result: SheetSelection;
    choice: FillChoice | null;
  } | null>(null);
  const copied = useRef<CopiedCells | null>(null);
  // A sheet chosen from the keyboard keeps the keyboard: its grid takes focus once drawn.
  const focusGrid = useRef(false);
  const picturePicker = useRef<HTMLInputElement>(null);
  const sheets = useMemo(() => (doc ? liveSheets(doc) : []), [doc]);
  const sheet = chosen && sheets.includes(chosen) ? chosen : (sheets[0] ?? null);
  useEffect(() => {
    // Run for each sheet shown: the grid is drawn anew for it.
    if (!focusGrid.current || !sheet) return;
    focusGrid.current = false;
    gridHost?.querySelector<HTMLElement>("[role=grid]")?.focus({ preventScroll: true });
  }, [sheet, gridHost]);
  const revision = state?.revision ?? 0;
  const moment = state?.moment ?? null;
  const calcContext = useMemo(
    () => (moment ? { revision, epoch: 0, ...moment } : null),
    [revision, moment],
  );
  const values = useSheetValues(doc, calcContext);
  // Read from the document and its values alone, so kept across what changes neither:
  // a key moving the selection, typing in a cell, someone else's cursor.
  const hiddenByFilter = useMemo(
    () => (doc && values && sheet ? filteredRows(doc, values, sheet) : NO_ROWS),
    [doc, values, sheet],
  );
  const looks = useMemo(
    () => (doc && values && sheet ? conditionalLooks(doc, values, sheet) : NO_LOOKS),
    [doc, values, sheet],
  );
  const findQuery = finding?.query ?? null;
  const matches = useMemo(() => {
    if (!doc || !values || !sheet || findQuery === null) return [];
    const [rows, cols] = [positions(doc.sheet[sheet]!.rows), positions(doc.sheet[sheet]!.cols)];
    const locale = sheetLocale(doc.settings.locale);
    return findMatches({ doc, values, sheet, locale, rows, cols }, findQuery);
  }, [doc, values, sheet, findQuery]);
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
  /** Threads on this sheet with the cells they sit on, by position; a gone corner leaves the first cell. */
  const placed = roots.flatMap((root) => {
    const at = doc.anchors[root.id];
    const [top, left] = at && at.sh === sheet ? [rows.at(at.r), cols.at(at.c)] : [];
    if (!at || top === undefined || left === undefined) return [];
    const bottom = Math.max(top, rows.at(at.r2 ?? at.r) ?? top);
    const right = Math.max(left, cols.at(at.c2 ?? at.c) ?? left);
    return [{ root, at, box: { top, left, bottom, right } }];
  });
  const [headRow, headCol] = [rows.at(head.r)!, cols.at(head.c)!];
  const here = placed.filter(
    ({ box }) =>
      headRow >= box.top && headRow <= box.bottom && headCol >= box.left && headCol <= box.right,
  );
  const shownThread = here.find(({ root }) => !root.resolvedAt) ?? here[0] ?? null;
  const cardOpen = commenting || (shownThread !== null && dismissed !== shownThread.root.id);
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
    if (next.head.r !== active.head.r || next.head.c !== active.head.c) {
      setCommenting(false);
      setDismissed(null);
    }
    setSelection(next);
    sync?.setCursor({ sheet, anchor: next.anchor, head: next.head });
  };
  /** Writes what was typed, unless the cell's validation refuses it, as Excel's Data Validation. */
  const commit = async (at: SheetSelection["head"], text: string) => {
    if (text === cellSource(doc, sheet, at.r, at.c, locale)) return;
    const ops = enterCell(context, at, text);
    const rule = validationAt(doc, sheet, at.r, at.c);
    if (rule && calcContext) {
      const after = applyChange(doc, { clientId: "check", seq: 0, ops }, 0).doc;
      const checked = calculateSheet(after, calcContext);
      const value = checked.value(sheet, at.r, at.c);
      if (!allowed(after, checked, rule, value, shownText(after, checked, sheet, at.r, at.c))) {
        const said = rule.message ?? "This value doesn’t match the rules for this cell.";
        if (rule.onError === "stop") {
          toast.error(said);
          return;
        }
        if (
          rule.onError === "warning" &&
          confirm &&
          !(await confirm({
            title: "Keep this value?",
            description: said,
            confirmLabel: "Keep",
            destructive: false,
          }))
        )
          return;
        if (rule.onError === "information") toast(said);
      }
    }
    run(ops);
  };
  const goTo = (index: number) => {
    if (!finding || !matches.length) return;
    const next = ((index % matches.length) + matches.length) % matches.length;
    setFinding({ ...finding, index: next });
    const at = { r: matches[next]!.r, c: matches[next]!.c };
    select({ anchor: at, head: at });
  };
  /** Shows another sheet, starting afresh on it. */
  const pickSheet = (id: string) => {
    setChosen(id);
    setSelection(null);
    setEditing(null);
  };
  // Every kind is named: a shortcut the panel does not handle must not fall through to clearing.
  const onCommand = (command: GridCommand) => {
    switch (command.kind) {
      case "find":
        return setFinding({ query: finding?.query ?? "", index: 0 });
      case "toggle":
        return run(
          eachRange(context, (each) =>
            formatSelection(each, { [command.property]: style[command.property] ? null : true }),
          ),
        );
      case "fill":
        return run(fillSelection(context, command.direction));
      case "filter":
        return run(toggleFilter(context));
      case "link":
        return setLinking(true);
      case "print":
        return printSheet(sheet);
      case "group":
        return run(groupSelection(context, outlineAxis(context)));
      case "ungroup":
        return run(ungroupSelection(context, outlineAxis(context)));
      case "undo":
        return sync?.undo();
      case "redo":
        return sync?.redo();
      case "clear":
        return run(eachRange(context, clearSelection));
      case "numberFormat":
        return run(
          eachRange(context, (each) =>
            formatSelection(each, { numberFormat: shortcutFormat(command.format, locale) }),
          ),
        );
      case "borders":
        return run(eachRange(context, (each) => borderSelection(each, command.border)));
      case "autosum":
        return run(autoSum(context, "SUM"));
      case "hide":
        return run(hideAtSelection(context, command.axis, command.hidden));
      case "insert":
        return run(insertAtSelection(context, command.axis, "before"));
      case "delete":
        return run(deleteAtSelection(context, command.axis));
      case "comment":
        return readOnly ? undefined : setCommenting(true);
      case "sheet": {
        const next = sheets[sheets.indexOf(sheet) + command.step];
        if (!next) return undefined;
        focusGrid.current = true;
        return pickSheet(next);
      }
      case "newSheet": {
        const id = sync!.mint();
        run([newSheet(doc, id)]);
        focusGrid.current = true;
        return pickSheet(id);
      }
    }
  };
  /** Prints a sheet through a frame of its own, so the page around it stays out of the print. */
  const printSheet = (id: string) => {
    const html = printHtml({ doc, values, locale }, id);
    if (!html) {
      toast("Nothing to print on this sheet");
      return;
    }
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    // The sheet's text runs no script there; the page may still reach in to print it.
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    Object.assign(frame.style, { position: "fixed", width: "0", height: "0", border: "0" });
    frame.addEventListener("load", () => {
      const printing = frame.contentWindow;
      if (!printing) return;
      printing.addEventListener("afterprint", () => frame.remove());
      printing.print();
    });
    frame.srcdoc = html;
    document.body.append(frame);
  };
  const onOutline: NonNullable<SheetGridProps["onOutline"]> = (axis, action) =>
    run(
      "group" in action
        ? toggleGroup(doc, sheet, axis, action.group)
        : showLevel(doc, sheet, axis, action.level),
    );
  const paste = (
    clip: { text: string; html: string | null; image?: File | null },
    options: { part?: PastePart; transpose?: boolean } = {},
  ) => {
    // A picture alone is placed as one; beside cells, as Excel copies them, the cells win.
    if (clip.image && !clip.text.trim() && !clip.html?.includes("<table")) {
      void insertPicture(clip.image);
      return;
    }
    const from = copied.current;
    const own = from?.text === clip.text;
    run(
      pasteAtSelection(context, clip.text, from, {
        ...options,
        foreign: !own && clip.html ? readHtmlTable(clip.html) : null,
      }),
    );
    // A cut moves once; pasting it again copies what now stands there.
    if (from?.cut && own && !options.part && !options.transpose) copied.current = null;
  };
  /** The clipboard for the menu's pastes, with its HTML where the browser lets that be read. */
  const pasteFromMenu = (options: { part?: PastePart; transpose?: boolean } = {}) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard
      .read()
      .then(async (items) => {
        const item = items.find((each) => each.types.includes("text/plain"));
        if (!item) return;
        const text = await (await item.getType("text/plain")).text();
        const html = item.types.includes("text/html")
          ? await (await item.getType("text/html")).text()
          : null;
        paste({ text, html }, options);
      })
      .catch(() => clipboard.readText().then((text) => paste({ text, html: null }, options)))
      .catch(() => toast.error("The browser didn’t allow reading the clipboard"));
  };
  const decorations: GridDecoration[] = [
    // A corner mark on each open thread's cell.
    // A corner mark on each open thread's last column, as Excel marks a note.
    ...placed
      .filter(({ root }) => !root.resolvedAt)
      .map(({ root, at, box }) => {
        const corner = { r: at.r, c: cols.ids[box.right - 1]! };
        return {
          key: `thread:${root.id}`,
          selection: { anchor: corner, head: corner },
          color: "var(--warning)",
          marker: true,
        };
      }),
    // The cells a shown thread is about, outlined while its card is open.
    ...(shownThread &&
    cardOpen &&
    shownThread.box.bottom + shownThread.box.right > shownThread.box.top + shownThread.box.left
      ? [
          {
            key: `thread-range:${shownThread.root.id}`,
            selection: {
              anchor: {
                r: rows.ids[shownThread.box.top - 1]!,
                c: cols.ids[shownThread.box.left - 1]!,
              },
              head: {
                r: rows.ids[shownThread.box.bottom - 1]!,
                c: cols.ids[shownThread.box.right - 1]!,
              },
            },
            color: "var(--warning)",
          },
        ]
      : []),
    // Circle Invalid Data: each cell breaking its validation, outlined in red.
    ...(circling
      ? [...invalidCells(doc, values, sheet)].slice(0, 500).map((key) => {
          const [r, c] = key.split("|") as [string, string];
          return {
            key: `invalid:${key}`,
            selection: { anchor: { r, c }, head: { r, c } },
            color: "var(--destructive)",
          };
        })
      : []),
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
  const cellName = (r: string, c: string) => `${columnLetters(cols.at(c)!)}${rows.at(r)}`;
  const rangeName = (on: string, box: { r1: string; r2: string; c1: string; c2: string }) =>
    rangeText(doc, sheet, on, box);
  const selectedBoxColumns = () =>
    cols.ids.slice(cols.at(selectedBox.c1)! - 1, cols.at(selectedBox.c2)!);
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
  const pickedChart =
    picked?.kind === "chart" && doc.charts[picked.id]?.sheet === sheet ? picked.id : null;
  const pickedImage =
    picked?.kind === "image" && doc.images?.[picked.id]?.sheet === sheet ? picked.id : null;
  if (pickedChart) decorations.push(...chartDecorations(doc.charts[pickedChart]!, sheet));
  const stats = selectionStats(context);
  const headRule = validationAt(doc, sheet, head.r, head.c);
  const sheetFilter = doc.sheet[sheet]!.filter;
  const filterAt = sheetFilter ? filterSpan(doc, sheet, sheetFilter) : null;
  // The Sort dialog's columns: the selection's, named by its first row's text.
  const sortColumns = selectedBoxColumns().map((c) => ({
    id: c,
    letter: columnLetters(cols.at(c)!),
    header: cellDisplay(
      values.value(sheet, selectedBox.r1, c),
      cellStyle(doc.sheet[sheet]!.cells[selectedBox.r1]?.[c]?.s),
      locale,
    ).text,
  }));
  // In the active cell's format, as Excel's status bar shows them, else as General.
  const shownNumber = (value: number) =>
    style.numberFormat
      ? (formatValue(value, style.numberFormat, locale)?.text ?? generalText(value, locale))
      : generalText(value, locale);
  const onToolbar = (command: ToolbarCommand) => {
    // Formats and clearing apply to every selected range; the rest to the active one.
    if (command.kind === "format")
      run(eachRange(context, (each) => formatSelection(each, command.patch)));
    else if (command.kind === "borders")
      run(eachRange(context, (each) => borderSelection(each, command.border, command.line)));
    else if (command.kind === "decimals")
      run(eachRange(context, (each) => decimalsSelection(each, command.delta)));
    else if (command.kind === "autosum") run(autoSum(context, command.fn));
    else if (command.kind === "merge") run(mergeSelection(context, command.merge));
    else if (command.kind === "freeze") run(freezeAt(context, command.freeze));
    else if (command.kind === "clear")
      run(eachRange(context, (each) => clearSelectionAs(each, command.what)));
    else if (command.kind === "filter") run(toggleFilter(context));
    else if (command.kind === "sort") setSorting(true);
    else if (command.kind === "validation") setValidating(true);
    else if (command.kind === "circles") setCircling(!circling);
    else if (command.kind === "link") setLinking(true);
    else if (command.kind === "picture") picturePicker.current?.click();
    else if (command.kind === "pivot") {
      const box = selectionBox(context);
      if (box.bottom - box.top < 1 || box.right === box.left)
        toast("Select the data to summarise first", {
          description: "Its first row names the columns.",
        });
      else setPivoting(true);
    } else if (command.kind === "outline")
      run(
        command.group
          ? groupSelection(context, command.axis)
          : ungroupSelection(context, command.axis),
      );
    else if (command.kind === "print") printSheet(sheet);
    else insertChart(command.chart);
  };
  /** A pivot table as its formula: on a sheet of its own, or two columns right of the data. */
  const insertPivot = (draft: PivotDraft) => {
    const box = selectionBox(context);
    const formula = pivotFormula(doc.sheet[sheet]!.name, box, draft);
    const beside = cols.ids[box.right + 1];
    if (draft.place === "beside" && beside) {
      run(enterCell(context, { r: rows.ids[box.top - 1]!, c: beside }, formula));
      return;
    }
    const id = sync!.mint();
    const added: SheetOp = {
      op: "sheetAdd",
      id,
      name: "Pivot",
      after: sheet,
      rows: Array.from({ length: NEW_SHEET.rows }, (_, n) => `${id}.r${n + 1}`),
      cols: Array.from({ length: NEW_SHEET.cols }, (_, n) => `${id}.c${n + 1}`),
    };
    const withSheet = applyChange(doc, { clientId: "pivot", seq: 0, ops: [added] }, 0).doc;
    run([
      added,
      ...enterCell(
        { ...context, doc: withSheet, sheet: id },
        { r: `${id}.r1`, c: `${id}.c1` },
        formula,
      ),
    ]);
    setChosen(id);
    setSelection(null);
  };
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
      setPicked({ kind: "chart", id: added.id });
      setChartEditing(added.id);
    }
  };
  const chartAction = (id: string, action: ChartAction) => {
    const chart = doc.charts[id];
    if (!chart) return;
    if (action === "edit") setChartEditing(id);
    else if (action === "delete") {
      run([{ op: "chartDelete", id }]);
      setPicked(null);
      if (chartEditing === id) setChartEditing(null);
    } else if (action === "duplicate") {
      const copy = sync!.mint();
      run([duplicateChart(doc, chart, copy)]);
      setPicked({ kind: "chart", id: copy });
    } else void chartImage(id, chartData(doc, values, chart).title, action);
  };
  /** A picture placed at the active cell, downscaled first; selected once placed. */
  const insertPicture = async (file: Blob) => {
    if (readOnly) return;
    const picture = await pictureOf(file);
    if (!picture) {
      toast("That picture can’t be added", {
        description: "Use a PNG, JPEG, GIF or WebP file.",
      });
      return;
    }
    if (Object.keys(doc.images ?? {}).length >= IMAGE_LIMITS.images) {
      toast(`A sheet document holds at most ${IMAGE_LIMITS.images} pictures`);
      return;
    }
    const id = sync!.mint();
    run([
      {
        op: "imagePut",
        id,
        image: {
          sheet,
          at: head,
          size: { width: picture.width, height: picture.height },
          src: picture.src,
        },
      },
    ]);
    setPicked({ kind: "image", id });
  };
  const imageAction = (id: string, action: OverlayCommand) => {
    const image = doc.images?.[id];
    if (!image || readOnly) return;
    if (action === "delete") {
      run([{ op: "imageDelete", id }]);
      setPicked(null);
    } else if (action === "duplicate") {
      const copy = sync!.mint();
      const { x = 0, y = 0 } = image.offset ?? {};
      run([{ op: "imagePut", id: copy, image: { ...image, offset: { x: x + 16, y: y + 16 } } }]);
      setPicked({ kind: "image", id: copy });
    }
  };
  const imageOverlays: GridOverlay[] = Object.entries(doc.images ?? {})
    .filter(([, image]) => image.sheet === sheet)
    .map(([id, image]) => ({
      key: overlayKey({ kind: "image", id }),
      at: image.at,
      ...(image.offset ? { offset: image.offset } : {}),
      width: image.size.width,
      height: image.size.height,
      label: image.alt ? `Picture: ${image.alt}` : "Picture",
      min: { width: IMAGE_LIMITS.width.min, height: IMAGE_LIMITS.height.min },
      content: (
        <img
          src={image.src}
          alt={image.alt ?? ""}
          draggable={false}
          className="pointer-events-none h-full w-full object-fill select-none"
        />
      ),
    }));
  const overlays: GridOverlay[] = Object.entries(doc.charts)
    .filter(([, chart]) => chart.sheet === sheet)
    .map(([id, chart]) => {
      const data = chartData(doc, values, chart);
      return {
        key: overlayKey({ kind: "chart", id }),
        at: chart.at,
        ...(chart.offset ? { offset: chart.offset } : {}),
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
  const cellOf = (at: CellAnchor) => [sheet, at.r, at.c, at.r2 ?? at.r, at.c2 ?? at.c];
  const sendToAssistant = async (thread: string, quote: string, body: string, at: CellAnchor) => {
    const sent = await ask?.(commentMessage(quote, body), { blocks: cellOf(at), thread }).catch(
      () => false,
    );
    if (!sent) toastError("Couldn’t send it to the assistant", null);
  };
  const threadActions = (at: CellAnchor): ThreadActions | null =>
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
  /** A thread's cells as they read now: where they are and what the first one shows. */
  const cellsLabel = (box: { r1: string; r2: string; c1: string; c2: string }) => {
    const shown = cellDisplay(
      values.value(sheet, box.r1, box.c1),
      cellStyle(doc.sheet[sheet]!.cells[box.r1]?.[box.c1]?.s),
      locale,
    ).text;
    const where =
      box.r1 !== box.r2 || box.c1 !== box.c2
        ? `${cellName(box.r1, box.c1)}:${cellName(box.r2, box.c2)}`
        : cellName(box.r1, box.c1);
    return `${where}${shown ? ` · ${shown}` : ""}`.slice(0, 500);
  };
  const startThread = async (body: string, toAssistant: boolean) => {
    const threadId = uuidv7();
    // The selection, as Excel and Sheets comment on a range; its first cell's text for the quote.
    const box = selectedBox;
    const range = box.r1 !== box.r2 || box.c1 !== box.c2;
    const at: CellAnchor = {
      sh: sheet,
      r: box.r1,
      c: box.c1,
      ...(range ? { r2: box.r2, c2: box.c2 } : {}),
    };
    // The quote keeps what the cells showed when the thread began, for a thread whose cells go.
    const quote = cellsLabel(box);
    try {
      await commentOnDocument({
        data: {
          documentId: controller.documentId,
          threadId,
          body,
          quote,
          toAssistant,
          cell: at,
        },
      });
    } catch (error) {
      toastError("Couldn’t add the comment.", error);
      return;
    }
    setCommenting(false);
    if (toAssistant) await sendToAssistant(threadId, quote, body, at);
  };
  // Where the comment card sits: beside the thread's cells, or the selection a new one is about.
  const cardBox = commenting
    ? {
        top: rows.at(selectedBox.r1)!,
        left: cols.at(selectedBox.c1)!,
        bottom: rows.at(selectedBox.r2)!,
        right: cols.at(selectedBox.c2)!,
      }
    : (shownThread?.box ?? null);
  // The grid places a box over the card's cells; the card sits beside it as the grid scrolls.
  const cardCells = cardBox
    ? {
        anchor: { r: rows.ids[cardBox.top - 1]!, c: cols.ids[cardBox.left - 1]! },
        head: { r: rows.ids[cardBox.bottom - 1]!, c: cols.ids[cardBox.right - 1]! },
      }
    : null;
  const threadsInOrder = placed
    .toSorted((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
    .map(({ root, at, box }) => ({
      root,
      at,
      box,
      where:
        box.top === box.bottom && box.left === box.right
          ? cellName(at.r, at.c)
          : `${cellName(at.r, at.c)}:${cellName(rows.ids[box.bottom - 1]!, cols.ids[box.right - 1]!)}`,
      replies: comments.filter((each) => each.threadId === root.id && each.id !== root.id).length,
    }));
  const commentButtons = (
    <>
      {readOnly ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Add comment"
                className="text-muted-foreground"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setCommenting(true)}
              />
            }
          >
            <HugeiconsIcon icon={CommentAdd01Icon} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent>Add comment</TooltipContent>
        </Tooltip>
      )}
      <SheetCommentsList
        threads={threadsInOrder}
        onPick={(thread) => {
          const found = threadsInOrder.find(({ root }) => root.id === thread);
          if (!found) return;
          setDismissed(null);
          select({
            anchor: {
              r: rows.ids[found.box.bottom - 1]!,
              c: cols.ids[found.box.right - 1]!,
            },
            head: { r: found.at.r, c: found.at.c },
          });
        }}
      />
      {menu}
    </>
  );
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
              onCommand={onToolbar}
              extra={commentButtons}
              conditional={
                <ConditionalMenu
                  rules={doc.sheet[sheet]!.conditional ?? []}
                  where={(rule) => {
                    const [top, left] = [rows.at(rule.box.r1), cols.at(rule.box.c1)];
                    const [bottom, right] = [rows.at(rule.box.r2), cols.at(rule.box.c2)];
                    return top && left && bottom && right
                      ? `${columnLetters(left)}${top}:${columnLetters(right)}${bottom}`
                      : "#REF!";
                  }}
                  onAdd={(rule) => run(addConditional(context, rule))}
                  onClear={(scope) => run(clearConditional(context, scope))}
                  onEdit={(id, action) => run(editConditional(context, id, action))}
                />
              }
              filtered={!!sheetFilter}
              circling={circling}
              preview={(code) => {
                const value = values.value(sheet, head.r, head.c);
                const shown = typeof value === "number" ? value : 1234.5;
                return code
                  ? (formatValue(shown, code, locale)?.text ?? "")
                  : cellDisplay(shown, {}, locale).text;
              }}
            />,
            toolbarSlot,
          )
        : null}
      {state.refused ? <FieldError className="mx-3 mt-2">{state.refused}</FieldError> : null}
      <FormulaBar
        address={address}
        text={barText}
        readOnly={readOnly}
        editing={!!editing}
        onStart={() => setEditing({ at: head, text: source, mode: "edit" })}
        onChange={(text) => setEditing({ at: head, text, mode: "edit" })}
        onCommit={() => {
          if (!editing) return;
          void commit(editing.at, editing.text);
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
      {finding ? (
        <FindBar
          query={finding.query}
          index={finding.index}
          count={matches.length}
          onQuery={(query) => setFinding({ query, index: 0 })}
          onGo={goTo}
          onClose={() => setFinding(null)}
        />
      ) : null}
      <div className="flex min-h-0 flex-1">
        <ContextMenu>
          <ContextMenuTrigger className="relative min-h-0 min-w-0 flex-1">
            <div ref={setGridHost} className="absolute inset-0">
              <SheetGrid
                zoom={zoom}
                {...(readOnly ? {} : { onOutline })}
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
                hiddenRows={hiddenByFilter}
                looks={looks}
                cellList={
                  headRule?.rule.kind === "list" ? listChoices(doc, values, headRule.rule) : null
                }
                onPickFromList={(value) => void commit(head, value)}
                filterButtons={
                  filterAt
                    ? {
                        row: filterAt.header,
                        cols: filterAt.columns,
                        active: new Set(Object.keys(sheetFilter!.rules)),
                      }
                    : null
                }
                onFilterButton={(col, anchor) => setFilterMenu({ col, anchor })}
                editSource={(at) => cellSource(doc, sheet, at.r, at.c, locale)}
                onCommand={onCommand}
                onCopy={(cut) => {
                  copied.current = copySelection(context, cut);
                  return { text: copied.current.text, html: selectionHtml(context) };
                }}
                onPaste={(clip) => paste(clip, clip.values ? { part: "values" } : {})}
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
                beside={cardCells ? { cells: cardCells, onElement: setCardAnchor } : null}
                overlays={[...overlays, ...imageOverlays]}
                selectedOverlay={
                  pickedChart
                    ? overlayKey({ kind: "chart", id: pickedChart })
                    : pickedImage
                      ? overlayKey({ kind: "image", id: pickedImage })
                      : null
                }
                onOverlaySelect={(key) => setPicked(key === null ? null : pickedOf(key))}
                onOverlayChange={(key, change) => {
                  const { kind, id } = pickedOf(key);
                  if (kind === "image") {
                    // Its place alone: the picture's bytes are not sent again on every move.
                    run([
                      {
                        op: "imagePlace",
                        id,
                        place: {
                          at: change.at,
                          ...(change.offset.x || change.offset.y ? { offset: change.offset } : {}),
                          size: {
                            width: Math.min(IMAGE_LIMITS.width.max, change.width),
                            height: Math.min(IMAGE_LIMITS.height.max, change.height),
                          },
                        },
                      },
                    ]);
                    return;
                  }
                  run([
                    {
                      op: "chartPatch",
                      id,
                      patch: {
                        at: change.at,
                        offset: change.offset.x || change.offset.y ? change.offset : null,
                        size: {
                          width: Math.min(CHART_LIMITS.width.max, change.width),
                          height: Math.min(CHART_LIMITS.height.max, change.height),
                        },
                      },
                    },
                  ]);
                }}
                onOverlayCommand={(key, command) => {
                  const { kind, id } = pickedOf(key);
                  if (kind === "image") imageAction(id, command);
                  else chartAction(id, command);
                }}
                onDragSelection={async (shift, copy) => {
                  const result = dragSelection(context, shift, copy);
                  if (!result || readOnly) return;
                  // As Excel asks before a drop writes over cells that hold something.
                  if (
                    confirm &&
                    dragOverwrites(context, shift) &&
                    !(await confirm({
                      title: "Replace the cells there?",
                      description: "Some of the cells you are dropping onto already hold data.",
                      confirmLabel: "Replace",
                    }))
                  )
                    return;
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
                activeAccessory={
                  safeLink(style.link) && sameSelection(active, { anchor: head, head }) ? (
                    <LinkChip
                      link={safeLink(style.link)!}
                      readOnly={readOnly}
                      onEdit={() => setLinking(true)}
                      onRemove={() => run(formatSelection(context, { link: null }))}
                    />
                  ) : null
                }
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
            ) : pickedImage ? (
              <>
                <MenuItem
                  icon={Copy01Icon}
                  label="Duplicate"
                  disabled={readOnly}
                  onClick={() => imageAction(pickedImage, "duplicate")}
                />
                <MenuItem
                  icon={Delete02Icon}
                  label="Delete picture"
                  disabled={readOnly}
                  onClick={() => imageAction(pickedImage, "delete")}
                />
              </>
            ) : (
              <CellMenuItems
                readOnly={readOnly}
                linked={!!style.link}
                context={context}
                run={run}
                onCopy={(cut) => {
                  copied.current = copySelection(context, cut);
                  writeClipboard(copied.current.text, selectionHtml(context));
                }}
                onPaste={pasteFromMenu}
                onComment={() => setCommenting(true)}
                onLink={() => setLinking(true)}
                onChart={insertChart}
              />
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
      {filterMenu && sheetFilter ? (
        <FilterMenu
          key={filterMenu.col}
          anchor={filterMenu.anchor}
          name={
            (filterAt &&
              cellDisplay(values.value(sheet, filterAt.header, filterMenu.col), {}, locale).text) ||
            columnLetters(cols.at(filterMenu.col) ?? 1)
          }
          choices={filterChoices(context, filterMenu.col)}
          rule={sheetFilter.rules[filterMenu.col]}
          onApply={(rule) => run(setFilterRule(context, filterMenu.col, rule))}
          onSort={(descending) => run(sortFilter(context, filterMenu.col, descending))}
          onClose={() => setFilterMenu(null)}
        />
      ) : null}
      <input
        ref={picturePicker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label="Picture to insert"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void insertPicture(file);
        }}
      />
      {pivoting && !readOnly ? (
        <PivotDialog
          fields={selectedBoxColumns().map(
            (c) =>
              cellDisplay(
                values.value(sheet, selectedBox.r1, c),
                cellStyle(doc.sheet[sheet]!.cells[selectedBox.r1]?.[c]?.s),
                locale,
              ).text || `Column ${columnLetters(cols.at(c)!)}`,
          )}
          onApply={insertPivot}
          onClose={() => setPivoting(false)}
        />
      ) : null}
      {linking && !readOnly ? (
        <LinkDialog
          text={cellDisplay(values.value(sheet, head.r, head.c), style, locale).text}
          link={style.link}
          textEditable={!doc.sheet[sheet]!.cells[head.r]?.[head.c]?.f}
          onApply={({ text, link }) =>
            run([
              ...(text === null
                ? []
                : [{ op: "set" as const, sh: sheet, cells: [{ ...head, v: text || null }] }]),
              ...formatSelection(context, { link }),
            ])
          }
          onClose={() => setLinking(false)}
        />
      ) : null}
      {validating && !readOnly ? (
        <ValidationDialog
          current={headRule}
          currentRange={
            headRule?.rule.kind === "list" && headRule.rule.source
              ? rangeName(headRule.rule.source.sh, headRule.rule.source.box)
              : null
          }
          readDate={(text) => {
            const typed = parseTyped(text, locale);
            return typed.kind === "number" ? typed.value : null;
          }}
          onApply={(draft) => {
            if (!draft) {
              run(setValidation(context, null));
              return;
            }
            const { rule, ...rest } = draft;
            if (rule.kind === "list" && "range" in rule) {
              const read = readRange(doc, sheet, rule.range);
              if (!read) {
                toast.error(`${rule.range} isn’t a range on this sheet.`);
                return;
              }
              run(
                setValidation(context, {
                  ...rest,
                  rule: { kind: "list", source: { sh: read.sheet, box: read.box } },
                }),
              );
            } else run(setValidation(context, { ...rest, rule }));
          }}
          onClose={() => setValidating(false)}
        />
      ) : null}
      {sorting && !readOnly ? (
        <SortDialog
          columns={sortColumns}
          headersByDefault={
            selectedBox.r1 !== selectedBox.r2 &&
            sortColumns.every(
              (column) => typeof values.value(sheet, selectedBox.r1, column.id) === "string",
            )
          }
          onSort={(keys, headers) => run(sortSelectionBy(context, keys, headers))}
          onClose={() => setSorting(false)}
        />
      ) : null}
      <Popover
        open={cardOpen && cardAnchor !== null}
        onOpenChange={(next) => {
          if (next) return;
          setCommenting(false);
          if (shownThread) setDismissed(shownThread.root.id);
        }}
      >
        {/* A thread opens beside its cells without taking focus from the grid; a new comment's field takes it. */}
        <PopoverContent
          anchor={cardAnchor}
          side="right"
          align="start"
          className="w-80"
          initialFocus={commenting}
        >
          {commenting ? (
            <CommentInput
              placeholder={`Comment on ${cardBox && (cardBox.top !== cardBox.bottom || cardBox.left !== cardBox.right) ? `${cellName(selectedBox.r1, selectedBox.c1)}:${cellName(selectedBox.r2, selectedBox.c2)}` : address}`}
              canAsk={ask !== null}
              autoFocus
              onSubmit={startThread}
            />
          ) : shownThread ? (
            <CommentThread
              root={shownThread.root}
              replies={comments.filter(
                (each) => each.threadId === shownThread.root.id && each.id !== shownThread.root.id,
              )}
              anchored
              me={me}
              actions={threadActions(shownThread.at)}
              expanded
              // The cells as they are now: a thread follows its cells, and their values change.
              // A gone far corner leaves the first cell, as the thread's place does.
              label={cellsLabel({
                r1: rows.ids[shownThread.box.top - 1]!,
                c1: cols.ids[shownThread.box.left - 1]!,
                r2: rows.ids[shownThread.box.bottom - 1]!,
                c2: cols.ids[shownThread.box.right - 1]!,
              })}
            />
          ) : null}
        </PopoverContent>
      </Popover>
      <div className="border-border flex shrink-0 items-center gap-3 border-t pr-3">
        <SheetTabs
          doc={doc}
          current={sheet}
          readOnly={readOnly}
          mint={() => sync!.mint()}
          run={run}
          onPick={pickSheet}
          onPrint={printSheet}
          onDownload={(id) => {
            const csv = sheetCsv({ doc, values, locale }, id);
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
            link.download = `${doc.sheet[id]!.name}.csv`;
            link.click();
            URL.revokeObjectURL(link.href);
          }}
        />
        {stats ? (
          <output
            aria-label="Selection summary"
            className="text-muted-foreground flex shrink-0 gap-3 text-xs whitespace-nowrap tabular-nums"
          >
            {stats.average !== null ? <span>Average: {shownNumber(stats.average)}</span> : null}
            <span>Count: {stats.count}</span>
            {stats.numbers ? <span>Sum: {shownNumber(stats.sum)}</span> : null}
          </output>
        ) : null}
        <SheetZoom zoom={zoom} onZoom={setZoom} />
      </div>
    </div>
  );
}
