import type { CSSProperties } from "react";
import { XError, type Scalar } from "@chat/sheet/engine/values";
import type { SheetLocale } from "@chat/sheet/locales";
import { renderFormula } from "@chat/sheet/model/formula";
import type { SheetDoc } from "@chat/sheet/model";
import { formatValue, generalText } from "@chat/sheet/number-format";

/** A cell's style properties, as the `format` operation writes them. */
export interface CellStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly fontSize?: number;
  readonly fontColor?: string;
  readonly fill?: string;
  readonly numberFormat?: string;
  readonly horizontal?: "left" | "center" | "right";
  readonly vertical?: "top" | "center" | "bottom";
  readonly wrap?: boolean;
  readonly borderTop?: boolean;
  readonly borderBottom?: boolean;
  readonly borderLeft?: boolean;
  readonly borderRight?: boolean;
}

// Style keys are canonical JSON shared by every cell with that style: parsed once each.
const parsed = new Map<string, CellStyle>();
export const cellStyle = (key: string | undefined): CellStyle => {
  if (!key) return {};
  let style = parsed.get(key);
  if (!style) {
    style = JSON.parse(key) as CellStyle;
    parsed.set(key, style);
  }
  return style;
};

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

const EDGE = "1px solid currentColor";
/** The style a cell's own properties give it; colours are the sheet's data, not the app's. */
export function cellCss(style: CellStyle): CSSProperties {
  return {
    ...(style.bold ? { fontWeight: 600 } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
    ...(style.fontSize ? { fontSize: `${(style.fontSize * 4) / 3}px` } : {}),
    ...(style.fontColor ? { color: style.fontColor } : {}),
    ...(style.fill ? { backgroundColor: style.fill } : {}),
    ...(style.wrap ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } : {}),
    ...(style.borderTop ? { borderTop: EDGE } : {}),
    ...(style.borderBottom ? { borderBottom: EDGE } : {}),
    ...(style.borderLeft ? { borderLeft: EDGE } : {}),
    ...(style.borderRight ? { borderRight: EDGE } : {}),
  };
}

/** What the formula bar shows for a cell: its formula as typed, else its value. */
export function cellSource(
  doc: SheetDoc,
  sheet: string,
  r: string,
  c: string,
  locale: SheetLocale,
) {
  const cell = doc.sheet[sheet]?.cells[r]?.[c];
  if (!cell) return "";
  if (cell.f) return `=${renderFormula(cell.f, { doc, sheet })}`;
  if (cell.v === undefined || cell.v === null) return "";
  if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
  if (typeof cell.v === "number") return generalText(cell.v, locale);
  return cell.v;
}
