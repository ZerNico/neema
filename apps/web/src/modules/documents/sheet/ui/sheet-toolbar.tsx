import { Toolbar } from "@base-ui/react/toolbar";
import {
  AlignBottomIcon,
  AlignTopIcon,
  AlignVerticalCenterIcon,
  ChartColumnIcon,
  Link01Icon,
  PivotIcon,
  PrinterIcon,
  MoreHorizontalIcon,
  ImageAdd01Icon,
  CheckListIcon,
  CircleIcon,
  ColumnDeleteIcon,
  ColumnInsertIcon,
  CommentAdd01Icon,
  RowDeleteIcon,
  RowInsertIcon,
  Search01Icon,
  SearchAddIcon,
  SearchMinusIcon,
  SortingAZ01Icon,
  SortingZA01Icon,
  TextIndentLessIcon,
  TextIndentMoreIcon,
  ViewIcon,
  ViewOffIcon,
  DecimalsArrowLeftIcon,
  DecimalsArrowRightIcon,
  EraserIcon,
  FilterIcon,
  MergeIcon,
  PaintBucketIcon,
  PercentIcon,
  Redo02Icon,
  SigmaIcon,
  SnowflakeIcon,
  SortingIcon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBoldIcon,
  TextColorIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
  TextWrapIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState, type ReactNode } from "react";
import type { ChartKind } from "@chat/sheet-react/commands";
import type { CellStyle } from "@chat/sheet/model/style";
import type {
  AutoSumKind,
  BorderKind,
  FreezeKind,
  MergeKind,
} from "@chat/sheet-react/format-commands";
import type { StylePatch } from "@chat/sheet/model/ops";
import type { BorderLine } from "@chat/sheet/model/style";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "~/ui/primitives/dropdown-menu";
import { Button } from "~/ui/primitives/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import { Tabs, TabsList, TabsTrigger } from "~/ui/primitives/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { Action, Format } from "../../ui/rich-editor/toolbar.tsx";
import { CHART_KINDS } from "./chart-kinds.ts";
import { BorderMenu } from "./border-menu.tsx";
import { ColorMenu, ToolbarMenu } from "./toolbar-controls.tsx";
import { ZOOM_STEPS, stepZoom } from "./zoom.ts";

/** What the toolbar asks of the sheet; the panel turns each into operations on the selection. */
export type ToolbarCommand =
  | { readonly kind: "format"; readonly patch: StylePatch }
  | { readonly kind: "borders"; readonly border: BorderKind; readonly line: BorderLine }
  | { readonly kind: "decimals"; readonly delta: 1 | -1 }
  | { readonly kind: "autosum"; readonly fn: AutoSumKind }
  | { readonly kind: "merge"; readonly merge: MergeKind }
  | { readonly kind: "freeze"; readonly freeze: FreezeKind }
  | { readonly kind: "clear"; readonly what: "formats" | "all" }
  | { readonly kind: "chart"; readonly chart: ChartKind }
  | { readonly kind: "filter" }
  | { readonly kind: "sort" }
  | { readonly kind: "sortOrder"; readonly descending: boolean }
  | { readonly kind: "find" }
  | { readonly kind: "comment" }
  | { readonly kind: "zoom"; readonly zoom: number }
  | { readonly kind: "insert"; readonly axis: Axis; readonly side: "before" | "after" }
  | { readonly kind: "delete"; readonly axis: Axis }
  | { readonly kind: "hide"; readonly axis: Axis; readonly hidden: boolean }
  | { readonly kind: "validation" }
  | { readonly kind: "circles" }
  | { readonly kind: "link" }
  | { readonly kind: "pivot" }
  | { readonly kind: "picture" }
  | { readonly kind: "print" }
  /** Without an axis, whole columns selected group columns and anything else rows. */
  | { readonly kind: "outline"; readonly group: boolean };
type Axis = "rows" | "columns";
/** The chart kinds the Insert tab shows as buttons; the rest are under More charts. */
const QUICK_CHARTS = new Set(["column", "line", "pie", "scatter"]);

/** Number formats by name, as Excel's list offers them; the code is what a cell keeps. */
const NUMBER_FORMATS = [
  { label: "General", code: null },
  { label: "Number", code: "#,##0.00" },
  { label: "Currency", code: "$#,##0.00" },
  { label: "Euro", code: "#,##0.00 €" },
  { label: "Accounting", code: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)' },
  { label: "Short date", code: "yyyy-mm-dd" },
  { label: "Long date", code: "dddd, d mmmm yyyy" },
  { label: "Time", code: "h:mm:ss" },
  { label: "Percentage", code: "0.00%" },
  { label: "Fraction", code: "# ?/?" },
  { label: "Scientific", code: "0.00E+00" },
  { label: "Text", code: "@" },
] as const;
const FONTS = [
  "Arial",
  "Calibri",
  "Cambria",
  "Courier New",
  "Georgia",
  "Helvetica",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
] as const;
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72] as const;
const ALIGNMENTS = [
  { value: "left", label: "Align left", icon: TextAlignLeftIcon },
  { value: "center", label: "Align centre", icon: TextAlignCenterIcon },
  { value: "right", label: "Align right", icon: TextAlignRightIcon },
] as const;
const VERTICAL = [
  { value: "top", label: "Top", icon: AlignTopIcon },
  { value: "center", label: "Middle", icon: AlignVerticalCenterIcon },
  { value: "bottom", label: "Bottom", icon: AlignBottomIcon },
] as const;
const SUMS: ReadonlyArray<{ fn: AutoSumKind; label: string }> = [
  { fn: "SUM", label: "Sum" },
  { fn: "AVERAGE", label: "Average" },
  { fn: "COUNT", label: "Count numbers" },
  { fn: "MAX", label: "Max" },
  { fn: "MIN", label: "Min" },
];
const Separator = () => <Toolbar.Separator className="bg-border mx-1 h-4 w-px" />;

/** One labelled group of a ribbon tab, as Excel's Font or Alignment. */
interface RibbonGroup {
  readonly id: string;
  readonly label: string;
  readonly controls: ReactNode;
}
const TABS = [
  { value: "home", label: "Home" },
  { value: "insert", label: "Insert" },
  { value: "data", label: "Data" },
  { value: "view", label: "View" },
] as const;
type TabName = (typeof TABS)[number]["value"];
/** Room kept for the More button when some groups do not fit. */
const MORE_PX = 40;

/**
 * A tab's groups on one line. Groups that do not fit go, last first, into a
 * More popover that holds the same controls, as Excel's simplified ribbon
 * does; each group is measured while it is on the line.
 */
function RibbonRow({ label, groups }: { label: string; groups: readonly RibbonGroup[] }) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    if (!row) return;
    const observer = new ResizeObserver(([entry]) => setRoom(entry?.contentRect.width ?? 0));
    observer.observe(row);
    return () => observer.disconnect();
  }, [row]);
  const measure = (id: string) => (element: HTMLDivElement | null) => {
    if (!element) return;
    const width = element.offsetWidth;
    setWidths((known) => (known[id] === width ? known : { ...known, [id]: width }));
  };
  const total = groups.reduce((sum, group) => sum + (widths[group.id] ?? 0), 0);
  // The first group always stays, so a narrow panel still has its commonest controls.
  const ends = groups.reduce<number[]>(
    (sums, group) => [...sums, (sums.at(-1) ?? 0) + (widths[group.id] ?? 0)],
    [],
  );
  const fitting = ends.findIndex((end, index) => index > 0 && end > room - MORE_PX);
  const shown = total <= room || fitting === -1 ? groups.length : fitting;
  // Even the first group cut short: More then holds it too, so nothing is out of reach.
  const cut = total > room && (ends[0] ?? 0) > room - MORE_PX;
  const more = groups.slice(cut ? 0 : shown);
  return (
    <div ref={setRow} className="flex min-w-0 items-center overflow-hidden">
      {/* The line clips before the More button does, so what did not fit stays reachable. */}
      <Toolbar.Root aria-label={label} className="flex min-w-0 items-center overflow-hidden">
        {groups.slice(0, shown).map((group, index) => (
          <div
            key={group.id}
            ref={measure(group.id)}
            role="group"
            aria-label={group.label}
            className="flex shrink-0 items-center gap-0.5"
          >
            {index ? <Separator /> : null}
            {group.controls}
          </div>
        ))}
      </Toolbar.Root>
      {more.length ? (
        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`More ${label} tools`}
                      className="text-muted-foreground shrink-0"
                    />
                  }
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>More</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-auto max-w-96">
            <Toolbar.Root aria-label={`More ${label} tools`} className="flex flex-col gap-3">
              {more.map((group) => (
                <div
                  key={group.id}
                  role="group"
                  aria-label={group.label}
                  className="flex flex-col gap-1"
                >
                  <span className="text-muted-foreground text-xs">{group.label}</span>
                  <div className="flex flex-wrap items-center gap-0.5">{group.controls}</div>
                </div>
              ))}
            </Toolbar.Root>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * A sheet's ribbon, as Excel's: Undo and Redo always at hand, then tabs of
 * grouped controls on one line each. `style` is the active cell's, shown
 * pressed; `extra`, the comment buttons, stays at the end for readers too.
 */
export function SheetToolbar({
  style,
  canUndo,
  canRedo,
  readOnly,
  onUndo,
  onRedo,
  onCommand,
  preview,
  extra,
  conditional,
  filtered = false,
  circling = false,
  zoom,
}: {
  style: CellStyle;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onCommand: (command: ToolbarCommand) => void;
  /** The active cell's value as a number format would show it, for the format list. */
  preview: (code: string | null) => string;
  /** Drawn at the ribbon's end, also for a reader: the comment buttons. */
  extra?: ReactNode;
  /** The conditional formatting menu, which keeps dialogs of its own. */
  conditional?: ReactNode;
  /** Whether cells breaking their validation are circled. */
  circling?: boolean;
  /** Whether the sheet has a filter, which the filter button shows pressed. */
  filtered?: boolean;
  zoom: number;
}) {
  const [tab, setTab] = useState<TabName>("home");
  if (readOnly)
    return extra ? (
      <Toolbar.Root aria-label="Comments" className="flex min-w-0 flex-1 items-center justify-end">
        {extra}
      </Toolbar.Root>
    ) : null;
  const format = (patch: StylePatch) => onCommand({ kind: "format", patch });
  const toggle = (key: "bold" | "italic" | "underline" | "strike" | "wrap") =>
    format({ [key]: style[key] ? null : true });
  const numberFormat = NUMBER_FORMATS.find((each) => each.code === (style.numberFormat ?? null));
  const vertical = VERTICAL.find((each) => each.value === (style.vertical ?? "bottom"))!;
  const sortAndFilter = (
    <>
      <Action
        icon={SortingAZ01Icon}
        label="Sort A to Z"
        disabled={false}
        onPress={() => onCommand({ kind: "sortOrder", descending: false })}
      />
      <Action
        icon={SortingZA01Icon}
        label="Sort Z to A"
        disabled={false}
        onPress={() => onCommand({ kind: "sortOrder", descending: true })}
      />
      <Action
        icon={SortingIcon}
        label="Sort…"
        disabled={false}
        onPress={() => onCommand({ kind: "sort" })}
      />
      <Format
        icon={FilterIcon}
        label="Filter"
        shortcut="⇧⌘L"
        pressed={filtered}
        onPress={() => onCommand({ kind: "filter" })}
      />
    </>
  );
  const groups: Record<TabName, readonly RibbonGroup[]> = {
    home: [
      {
        id: "font",
        label: "Font",
        controls: (
          <>
            <ToolbarMenu label="Font" text={style.fontFamily ?? "Default font"}>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => format({ fontFamily: null })}>
                  Default font
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {FONTS.map((font) => (
                  <DropdownMenuItem key={font} onClick={() => format({ fontFamily: font })}>
                    <span style={{ fontFamily: font }}>{font}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </ToolbarMenu>
            <ToolbarMenu label="Font size" text={String(style.fontSize ?? 11)}>
              <DropdownMenuContent align="start" className="w-24">
                {SIZES.map((size) => (
                  <DropdownMenuItem
                    key={size}
                    onClick={() => format({ fontSize: size === 11 ? null : size })}
                  >
                    {size}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </ToolbarMenu>
            <Format
              icon={TextBoldIcon}
              label="Bold"
              shortcut="⌘B"
              pressed={!!style.bold}
              onPress={() => toggle("bold")}
            />
            <Format
              icon={TextItalicIcon}
              label="Italic"
              shortcut="⌘I"
              pressed={!!style.italic}
              onPress={() => toggle("italic")}
            />
            <Format
              icon={TextUnderlineIcon}
              label="Underline"
              shortcut="⌘U"
              pressed={!!style.underline}
              onPress={() => toggle("underline")}
            />
            <Format
              icon={TextStrikethroughIcon}
              label="Strikethrough"
              pressed={!!style.strike}
              onPress={() => toggle("strike")}
            />
            <ColorMenu
              label="Text colour"
              icon={TextColorIcon}
              value={style.fontColor}
              resetLabel="Automatic"
              onChange={(color) => format({ fontColor: color })}
            />
            <ColorMenu
              label="Fill colour"
              icon={PaintBucketIcon}
              value={style.fill}
              resetLabel="No fill"
              onChange={(color) => format({ fill: color })}
            />
            <BorderMenu onBorder={(border, line) => onCommand({ kind: "borders", border, line })} />
          </>
        ),
      },
      {
        id: "alignment",
        label: "Alignment",
        controls: (
          <>
            {ALIGNMENTS.map((alignment) => (
              <Format
                key={alignment.value}
                icon={alignment.icon}
                label={alignment.label}
                pressed={style.horizontal === alignment.value}
                onPress={() =>
                  format({
                    horizontal: style.horizontal === alignment.value ? null : alignment.value,
                  })
                }
              />
            ))}
            <ToolbarMenu label="Vertical alignment" icon={vertical.icon}>
              <DropdownMenuContent align="start" className="w-36">
                {VERTICAL.map((each) => (
                  <DropdownMenuItem
                    key={each.value}
                    onClick={() =>
                      format({ vertical: each.value === "bottom" ? null : each.value })
                    }
                  >
                    <HugeiconsIcon icon={each.icon} strokeWidth={2} />
                    {each.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </ToolbarMenu>
            <Format
              icon={TextWrapIcon}
              label="Wrap text"
              pressed={!!style.wrap}
              onPress={() => toggle("wrap")}
            />
            <ToolbarMenu label="Merge" icon={MergeIcon}>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuItem onClick={() => onCommand({ kind: "merge", merge: "center" })}>
                  Merge &amp; centre
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCommand({ kind: "merge", merge: "across" })}>
                  Merge across
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCommand({ kind: "merge", merge: "cells" })}>
                  Merge cells
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCommand({ kind: "merge", merge: "unmerge" })}>
                  Unmerge cells
                </DropdownMenuItem>
              </DropdownMenuContent>
            </ToolbarMenu>
          </>
        ),
      },
      {
        id: "number",
        label: "Number",
        controls: (
          <>
            <ToolbarMenu label="Number format" text={numberFormat?.label ?? "Custom"}>
              <DropdownMenuContent align="start" className="w-64">
                {NUMBER_FORMATS.map((each) => (
                  <DropdownMenuItem
                    key={each.label}
                    onClick={() => format({ numberFormat: each.code })}
                  >
                    <span className="flex-1">{each.label}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {preview(each.code)}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </ToolbarMenu>
            <Format
              icon={PercentIcon}
              label="Percent style"
              pressed={style.numberFormat === "0%"}
              onPress={() => format({ numberFormat: style.numberFormat === "0%" ? null : "0%" })}
            />
            <Action
              icon={DecimalsArrowLeftIcon}
              label="Decrease decimal"
              disabled={false}
              onPress={() => onCommand({ kind: "decimals", delta: -1 })}
            />
            <Action
              icon={DecimalsArrowRightIcon}
              label="Increase decimal"
              disabled={false}
              onPress={() => onCommand({ kind: "decimals", delta: 1 })}
            />
          </>
        ),
      },
      ...(conditional ? [{ id: "styles", label: "Styles", controls: conditional }] : []),
      {
        id: "editing",
        label: "Editing",
        controls: (
          <>
            <ToolbarMenu label="AutoSum" icon={SigmaIcon}>
              <DropdownMenuContent align="start" className="w-40">
                {SUMS.map((each) => (
                  <DropdownMenuItem
                    key={each.fn}
                    onClick={() => onCommand({ kind: "autosum", fn: each.fn })}
                  >
                    {each.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </ToolbarMenu>
            <ToolbarMenu label="Clear" icon={EraserIcon}>
              <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuItem onClick={() => onCommand({ kind: "clear", what: "formats" })}>
                  Clear formats
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCommand({ kind: "clear", what: "all" })}>
                  Clear all
                </DropdownMenuItem>
              </DropdownMenuContent>
            </ToolbarMenu>
            <Action
              icon={Search01Icon}
              label="Find"
              shortcut="⌘F"
              disabled={false}
              onPress={() => onCommand({ kind: "find" })}
            />
          </>
        ),
      },
    ],
    insert: [
      {
        id: "tables",
        label: "Tables",
        controls: (
          <Action
            icon={PivotIcon}
            label="Insert pivot table"
            disabled={false}
            onPress={() => onCommand({ kind: "pivot" })}
          />
        ),
      },
      {
        id: "charts",
        label: "Charts",
        controls: (
          <>
            {CHART_KINDS.filter((each) => QUICK_CHARTS.has(each.kind)).map((each) => (
              <Action
                key={each.kind}
                icon={each.icon}
                label={`${each.label} chart`}
                disabled={false}
                onPress={() => onCommand({ kind: "chart", chart: each.kind })}
              />
            ))}
            <ToolbarMenu label="More charts" icon={ChartColumnIcon}>
              <DropdownMenuContent align="start" className="w-40">
                {CHART_KINDS.filter((each) => !QUICK_CHARTS.has(each.kind)).map((each) => (
                  <DropdownMenuItem
                    key={each.kind}
                    onClick={() => onCommand({ kind: "chart", chart: each.kind })}
                  >
                    <HugeiconsIcon icon={each.icon} strokeWidth={2} />
                    {each.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </ToolbarMenu>
          </>
        ),
      },
      {
        id: "illustrations",
        label: "Illustrations",
        controls: (
          <Action
            icon={ImageAdd01Icon}
            label="Insert picture"
            disabled={false}
            onPress={() => onCommand({ kind: "picture" })}
          />
        ),
      },
      {
        id: "links",
        label: "Links and comments",
        controls: (
          <>
            <Action
              icon={Link01Icon}
              label="Insert link"
              shortcut="⌘K"
              disabled={false}
              onPress={() => onCommand({ kind: "link" })}
            />
            <Action
              icon={CommentAdd01Icon}
              label="New comment"
              shortcut="⇧F2"
              disabled={false}
              onPress={() => onCommand({ kind: "comment" })}
            />
          </>
        ),
      },
    ],
    data: [
      { id: "sort", label: "Sort and filter", controls: sortAndFilter },
      {
        id: "tools",
        label: "Data tools",
        controls: (
          <>
            <Action
              icon={CheckListIcon}
              label="Data validation"
              disabled={false}
              onPress={() => onCommand({ kind: "validation" })}
            />
            <Format
              icon={CircleIcon}
              label={circling ? "Clear validation circles" : "Circle invalid data"}
              pressed={circling}
              onPress={() => onCommand({ kind: "circles" })}
            />
          </>
        ),
      },
      {
        id: "cells",
        label: "Rows and columns",
        controls: (
          <>
            <ToolbarMenu label="Insert cells" icon={RowInsertIcon}>
              <DropdownMenuContent align="start" className="w-48">
                {(
                  [
                    ["Insert rows above", "rows", "before", RowInsertIcon],
                    ["Insert rows below", "rows", "after", RowInsertIcon],
                    ["Insert columns left", "columns", "before", ColumnInsertIcon],
                    ["Insert columns right", "columns", "after", ColumnInsertIcon],
                  ] as const
                ).map(([text, axis, side, icon]) => (
                  <DropdownMenuItem
                    key={text}
                    onClick={() => onCommand({ kind: "insert", axis, side })}
                  >
                    <HugeiconsIcon icon={icon} strokeWidth={2} />
                    {text}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </ToolbarMenu>
            <ToolbarMenu label="Delete cells" icon={RowDeleteIcon}>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuItem onClick={() => onCommand({ kind: "delete", axis: "rows" })}>
                  <HugeiconsIcon icon={RowDeleteIcon} strokeWidth={2} />
                  Delete rows
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCommand({ kind: "delete", axis: "columns" })}>
                  <HugeiconsIcon icon={ColumnDeleteIcon} strokeWidth={2} />
                  Delete columns
                </DropdownMenuItem>
              </DropdownMenuContent>
            </ToolbarMenu>
            <ToolbarMenu label="Hide and unhide" icon={ViewOffIcon}>
              <DropdownMenuContent align="start" className="w-44">
                {(
                  [
                    ["Hide rows", "rows", true],
                    ["Hide columns", "columns", true],
                    ["Unhide rows", "rows", false],
                    ["Unhide columns", "columns", false],
                  ] as const
                ).map(([text, axis, hidden]) => (
                  <DropdownMenuItem
                    key={text}
                    onClick={() => onCommand({ kind: "hide", axis, hidden })}
                  >
                    <HugeiconsIcon icon={hidden ? ViewOffIcon : ViewIcon} strokeWidth={2} />
                    {text}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </ToolbarMenu>
          </>
        ),
      },
      {
        id: "outline",
        label: "Outline",
        controls: (
          <>
            <Action
              icon={TextIndentMoreIcon}
              label="Group"
              shortcut="⇧⌘K"
              disabled={false}
              onPress={() => onCommand({ kind: "outline", group: true })}
            />
            <Action
              icon={TextIndentLessIcon}
              label="Ungroup"
              shortcut="⇧⌘J"
              disabled={false}
              onPress={() => onCommand({ kind: "outline", group: false })}
            />
          </>
        ),
      },
    ],
    view: [
      {
        id: "window",
        label: "Window",
        controls: (
          <ToolbarMenu label="Freeze panes" icon={SnowflakeIcon}>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem onClick={() => onCommand({ kind: "freeze", freeze: "selection" })}>
                Freeze panes
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCommand({ kind: "freeze", freeze: "top" })}>
                Freeze top row
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCommand({ kind: "freeze", freeze: "first" })}>
                Freeze first column
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCommand({ kind: "freeze", freeze: "none" })}>
                Unfreeze panes
              </DropdownMenuItem>
            </DropdownMenuContent>
          </ToolbarMenu>
        ),
      },
      {
        id: "zoom",
        label: "Zoom",
        controls: (
          <>
            <Action
              icon={SearchMinusIcon}
              label="Zoom out"
              disabled={zoom <= ZOOM_STEPS[0]}
              onPress={() => onCommand({ kind: "zoom", zoom: stepZoom(zoom, -1) })}
            />
            <ToolbarMenu label="Zoom" text={`${Math.round(zoom * 100)}%`}>
              <DropdownMenuContent align="start" className="w-24">
                {ZOOM_STEPS.map((step) => (
                  <DropdownMenuItem
                    key={step}
                    onClick={() => onCommand({ kind: "zoom", zoom: step })}
                  >
                    {Math.round(step * 100)}%
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </ToolbarMenu>
            <Action
              icon={SearchAddIcon}
              label="Zoom in"
              disabled={zoom >= ZOOM_STEPS.at(-1)!}
              onPress={() => onCommand({ kind: "zoom", zoom: stepZoom(zoom, 1) })}
            />
          </>
        ),
      },
      {
        id: "print",
        label: "Print",
        controls: (
          <Action
            icon={PrinterIcon}
            label="Print"
            shortcut="⌘P"
            disabled={false}
            onPress={() => onCommand({ kind: "print" })}
          />
        ),
      },
    ],
  };
  const label = TABS.find((each) => each.value === tab)!.label;
  return (
    // A size container: in a panel too narrow for one line, the tabs take a line of their own.
    <Tabs
      value={tab}
      onValueChange={(next: TabName) => setTab(next)}
      className="@container min-w-0 flex-1"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Toolbar.Root aria-label="History" className="flex shrink-0 items-center gap-0.5">
          <Action
            icon={Undo02Icon}
            label="Undo"
            shortcut="⌘Z"
            disabled={!canUndo}
            onPress={onUndo}
          />
          <Action
            icon={Redo02Icon}
            label="Redo"
            shortcut="⇧⌘Z"
            disabled={!canRedo}
            onPress={onRedo}
          />
        </Toolbar.Root>
        <TabsList
          variant="line"
          size="sm"
          className="@max-[25rem]:order-last @max-[25rem]:basis-full"
        >
          {TABS.map((each) => (
            <TabsTrigger key={each.value} value={each.value}>
              {each.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {extra ? (
          <Toolbar.Root aria-label="Comments" className="ml-auto flex shrink-0 items-center">
            {extra}
          </Toolbar.Root>
        ) : null}
      </div>
      <RibbonRow key={tab} label={label} groups={groups[tab]} />
    </Tabs>
  );
}
