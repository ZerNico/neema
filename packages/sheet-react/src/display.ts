import type { BorderLine, CellStyle } from "@chat/sheet/model/style";
import type { CSSProperties } from "react";
import { XError, type Scalar } from "@chat/sheet/engine/values";
import type { SheetLocale } from "@chat/sheet/locales";
import { localizeFormula } from "@chat/sheet/formula-locale";
import { renderFormula } from "@chat/sheet/model/formula";
import { positions, type Sheet, type SheetDoc } from "@chat/sheet/model";
import type { CellRef } from "./selection.ts";
import { formatValue, generalText } from "@chat/sheet/number-format";

/** Covered coordinates show the merge anchor's content, including its link. */
export function mergeAnchor(sheet: Sheet, at: CellRef): CellRef {
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  const row = rows.at(at.r);
  const col = cols.at(at.c);
  if (row === undefined || col === undefined) return at;
  for (const span of sheet.merges) {
    const top = rows.at(span.r1);
    const bottom = rows.at(span.r2);
    const left = cols.at(span.c1);
    const right = cols.at(span.c2);
    if (
      top !== undefined &&
      bottom !== undefined &&
      left !== undefined &&
      right !== undefined &&
      row >= top &&
      row <= bottom &&
      col >= left &&
      col <= right
    )
      return { r: span.r1, c: span.c1 };
  }
  return at;
}

/** A link a cell may open: web and mail addresses only, never script. */
export function safeLink(text: string | undefined): string | null {
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** What a cell shows and where it sits: numbers right, text left, the rest centred, as Excel does. */
export function cellDisplay(value: Scalar, style: CellStyle, locale: SheetLocale) {
  const natural =
    typeof value === "number" ? "right" : typeof value === "string" ? "left" : "center";
  const align = style.horizontal ?? natural;
  if (value === null) return { text: "", align, color: undefined };
  if (value instanceof XError) return { text: value.code, align, color: undefined };
  if (typeof value === "boolean")
    return { text: value ? "TRUE" : "FALSE", align, color: undefined };
  const formatted = style.numberFormat ? formatValue(value, style.numberFormat, locale) : null;
  if (formatted) return { text: formatted.text, align, color: formatted.color };
  return {
    text: typeof value === "number" ? generalText(value, locale) : value,
    align,
    color: undefined,
  };
}

/** Each line style's width and CSS style on screen, as Excel draws them at 100%. */
const LINES: Readonly<Record<BorderLine["style"], readonly [number, string]>> = {
  thin: [1, "solid"],
  medium: [2, "solid"],
  thick: [3, "solid"],
  dashed: [1, "dashed"],
  dotted: [1, "dotted"],
  double: [3, "double"],
};
/** A cell edge as CSS, in its own colour or the text's. */
export const edgeCss = (line: BorderLine) => {
  const [width, style] = LINES[line.style];
  return `${width}px ${style} ${line.color ?? "currentColor"}`;
};
/** The style a cell's own properties give it; colours are the sheet's data, not the app's. */
export function cellCss(style: CellStyle): CSSProperties {
  return {
    ...(style.bold ? { fontWeight: 600 } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
    ...(style.underline || style.strike
      ? {
          textDecorationLine: [style.underline && "underline", style.strike && "line-through"]
            .filter(Boolean)
            .join(" "),
        }
      : {}),
    ...(style.fontFamily ? { fontFamily: `"${style.fontFamily}", ui-sans-serif, sans-serif` } : {}),
    ...(style.fontSize ? { fontSize: `${(style.fontSize * 4) / 3}px` } : {}),
    ...(style.fontColor ? { color: style.fontColor } : {}),
    ...(style.fill ? { backgroundColor: style.fill } : {}),
    ...(style.wrap ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } : {}),
    ...(style.borderTop ? { borderTop: edgeCss(style.borderTop) } : {}),
    ...(style.borderBottom ? { borderBottom: edgeCss(style.borderBottom) } : {}),
    ...(style.borderLeft ? { borderLeft: edgeCss(style.borderLeft) } : {}),
    ...(style.borderRight ? { borderRight: edgeCss(style.borderRight) } : {}),
  };
}

/** What the formula bar shows for a cell: its formula as the locale types it, else its value. */
export function cellSource(
  doc: SheetDoc,
  sheet: string,
  r: string,
  c: string,
  locale: SheetLocale,
) {
  const cell = doc.sheet[sheet]?.cells[r]?.[c];
  if (!cell) return "";
  if (cell.f) return `=${localizeFormula(renderFormula(cell.f, { doc, sheet }), locale)}`;
  if (cell.v === undefined || cell.v === null) return "";
  if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
  if (typeof cell.v === "number") return generalText(cell.v, locale);
  return cell.v;
}
