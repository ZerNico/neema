import { Toolbar } from "@base-ui/react/toolbar";
import {
  AlignBottomIcon,
  AlignTopIcon,
  AlignVerticalCenterIcon,
  BorderAll01Icon,
  BorderBottomIcon,
  BorderFullIcon,
  BorderInnerIcon,
  BorderLeftIcon,
  BorderNone01Icon,
  BorderRightIcon,
  BorderTopIcon,
  ChartColumnIcon,
  DecimalsArrowLeftIcon,
  DecimalsArrowRightIcon,
  EraserIcon,
  MergeIcon,
  PaintBucketIcon,
  PercentIcon,
  Redo02Icon,
  SigmaIcon,
  SnowflakeIcon,
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
import type { ReactNode } from "react";
import type { ChartKind } from "@chat/sheet-react/commands";
import type { CellStyle } from "@chat/sheet-react/display";
import type {
  AutoSumKind,
  BorderKind,
  FreezeKind,
  MergeKind,
} from "@chat/sheet-react/format-commands";
import type { StylePatch } from "@chat/sheet/model/ops";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "~/ui/primitives/dropdown-menu";
import { Action, Format } from "../../ui/rich-editor/toolbar.tsx";
import { CHART_KINDS } from "./chart-kinds.ts";
import { ColorMenu, ToolbarMenu } from "./toolbar-controls.tsx";

/** What the toolbar asks of the sheet; the panel turns each into operations on the selection. */
export type ToolbarCommand =
  | { readonly kind: "format"; readonly patch: StylePatch }
  | { readonly kind: "borders"; readonly border: BorderKind }
  | { readonly kind: "decimals"; readonly delta: 1 | -1 }
  | { readonly kind: "autosum"; readonly fn: AutoSumKind }
  | { readonly kind: "merge"; readonly merge: MergeKind }
  | { readonly kind: "freeze"; readonly freeze: FreezeKind }
  | { readonly kind: "clear"; readonly what: "formats" | "all" }
  | { readonly kind: "chart"; readonly chart: ChartKind };

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
const BORDERS: ReadonlyArray<{ border: BorderKind; label: string; icon: typeof BorderAll01Icon }> =
  [
    { border: "all", label: "All borders", icon: BorderAll01Icon },
    { border: "outer", label: "Outside borders", icon: BorderFullIcon },
    { border: "inner", label: "Inside borders", icon: BorderInnerIcon },
    { border: "top", label: "Top border", icon: BorderTopIcon },
    { border: "bottom", label: "Bottom border", icon: BorderBottomIcon },
    { border: "left", label: "Left border", icon: BorderLeftIcon },
    { border: "right", label: "Right border", icon: BorderRightIcon },
    { border: "none", label: "No border", icon: BorderNone01Icon },
  ];
const SUMS: ReadonlyArray<{ fn: AutoSumKind; label: string }> = [
  { fn: "SUM", label: "Sum" },
  { fn: "AVERAGE", label: "Average" },
  { fn: "COUNT", label: "Count numbers" },
  { fn: "MAX", label: "Max" },
  { fn: "MIN", label: "Min" },
];
const Separator = () => <Toolbar.Separator className="bg-border mx-1 h-4 w-px" />;

/** A sheet's formatting row, as Excel's Home tab; `style` is the active cell's, shown pressed. */
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
  /** Drawn at the toolbar's end, also for a reader: the comment buttons. */
  extra?: ReactNode;
}) {
  if (readOnly)
    return extra ? (
      <Toolbar.Root
        aria-label="Formatting"
        className="flex min-w-0 flex-1 items-center justify-end"
      >
        {extra}
      </Toolbar.Root>
    ) : null;
  const format = (patch: StylePatch) => onCommand({ kind: "format", patch });
  const toggle = (key: "bold" | "italic" | "underline" | "strike" | "wrap") =>
    format({ [key]: style[key] ? null : true });
  const numberFormat = NUMBER_FORMATS.find((each) => each.code === (style.numberFormat ?? null));
  const vertical = VERTICAL.find((each) => each.value === (style.vertical ?? "bottom"))!;
  return (
    <Toolbar.Root
      aria-label="Formatting"
      className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5"
    >
      <Action icon={Undo02Icon} label="Undo" shortcut="⌘Z" disabled={!canUndo} onPress={onUndo} />
      <Action icon={Redo02Icon} label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onPress={onRedo} />
      <Separator />
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
      <ToolbarMenu label="Borders" icon={BorderAll01Icon}>
        <DropdownMenuContent align="start" className="w-48">
          {BORDERS.map((each) => (
            <DropdownMenuItem
              key={each.border}
              onClick={() => onCommand({ kind: "borders", border: each.border })}
            >
              <HugeiconsIcon icon={each.icon} strokeWidth={2} />
              {each.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </ToolbarMenu>
      <Separator />
      {ALIGNMENTS.map((alignment) => (
        <Format
          key={alignment.value}
          icon={alignment.icon}
          label={alignment.label}
          pressed={style.horizontal === alignment.value}
          onPress={() =>
            format({ horizontal: style.horizontal === alignment.value ? null : alignment.value })
          }
        />
      ))}
      <ToolbarMenu label="Vertical alignment" icon={vertical.icon}>
        <DropdownMenuContent align="start" className="w-36">
          {VERTICAL.map((each) => (
            <DropdownMenuItem
              key={each.value}
              onClick={() => format({ vertical: each.value === "bottom" ? null : each.value })}
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
      <Separator />
      <ToolbarMenu label="Number format" text={numberFormat?.label ?? "Custom"}>
        <DropdownMenuContent align="start" className="w-64">
          {NUMBER_FORMATS.map((each) => (
            <DropdownMenuItem key={each.label} onClick={() => format({ numberFormat: each.code })}>
              <span className="flex-1">{each.label}</span>
              <span className="text-muted-foreground truncate text-xs">{preview(each.code)}</span>
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
      <Separator />
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
      <ToolbarMenu label="Insert chart" icon={ChartColumnIcon}>
        <DropdownMenuContent align="start" className="w-40">
          {CHART_KINDS.map((each) => (
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
      {extra ? (
        <>
          <Separator />
          {extra}
        </>
      ) : null}
    </Toolbar.Root>
  );
}
