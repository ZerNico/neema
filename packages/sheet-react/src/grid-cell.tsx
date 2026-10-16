import { memo } from "react";
import type { Scalar } from "@chat/sheet/engine/values";
import type { SheetLocale } from "@chat/sheet/locales";
import { cellStyle } from "@chat/sheet/style";
import { cellCss, cellDisplay } from "./display.ts";
import type { CellLook } from "./looks.ts";

/**
 * One drawn cell, given only plain values, so a redraw of the grid passes over
 * every cell whose own content, look and place stayed the same.
 */
export const GridCell = memo(function GridCell({
  id,
  main,
  active,
  row,
  col,
  top,
  left,
  height,
  width,
  value,
  styleKey,
  look,
  locale,
  spills,
  merged,
}: {
  id: string | undefined;
  /** Only the scrolling pane's cells are named for assistive tech; frozen ones repeat them. */
  main: boolean;
  active: boolean;
  row: number;
  col: number;
  top: number;
  left: number;
  height: number;
  width: number;
  value: Scalar;
  styleKey: string | undefined;
  look: CellLook | undefined;
  locale: SheetLocale;
  /** Its text runs on over the empty cells to its right. */
  spills: boolean;
  merged: boolean;
}) {
  // Conditional formats show over the cell's own style, as Excel draws them.
  const own = cellStyle(styleKey);
  const style = look
    ? {
        ...own,
        ...(look.fill ? { fill: look.fill } : {}),
        ...(look.fontColor ? { fontColor: look.fontColor } : {}),
        ...(look.bold ? { bold: true } : {}),
        ...(look.italic ? { italic: true } : {}),
      }
    : own;
  const shown = cellDisplay(value, style, locale);
  return (
    <div
      id={id}
      role={main ? "gridcell" : undefined}
      aria-rowindex={main ? row + 1 : undefined}
      aria-colindex={main ? col + 1 : undefined}
      aria-selected={active || undefined}
      className={`border-border text-foreground absolute flex border-b px-1 text-sm leading-tight whitespace-pre ${spills ? "overflow-visible" : "overflow-hidden border-r"}`}
      style={{
        top,
        left,
        height,
        width,
        alignItems:
          style.vertical === "top"
            ? "flex-start"
            : style.vertical === "center"
              ? "center"
              : "flex-end",
        justifyContent:
          shown.align === "right" ? "flex-end" : shown.align === "center" ? "center" : "flex-start",
        textAlign: shown.align,
        // Its fill and borders stay in its own column; only its text runs on, above the spill.
        zIndex: spills ? 2 : merged ? 1 : undefined,
        ...cellCss(style),
        fontSize: style.fontSize ? (style.fontSize * 4) / 3 : 14,
        ...(shown.color ? { color: shown.color } : {}),
      }}
    >
      {look?.bar ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-xs opacity-60"
          style={{
            width: `calc(${look.bar.fraction * 100}% - 4px)`,
            // The rule's own colour, which is the sheet's data.
            background: `linear-gradient(to right, ${look.bar.color}, color-mix(in oklab, ${look.bar.color} 30%, transparent))`,
          }}
        />
      ) : null}
      <span
        className={
          own.link
            ? `relative underline underline-offset-2${style.fontColor || shown.color ? "" : " text-primary"}`
            : "relative"
        }
      >
        {shown.text}
      </span>
    </div>
  );
});
