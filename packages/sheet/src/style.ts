/** A cell's look, as a workbook's reader resolves it: colours are #RRGGBB. */
export interface CellStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  /** A font by name; absent, the grid's own. */
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontColor?: string;
  readonly fill?: string;
  readonly numberFormat?: string;
  readonly horizontal?: "left" | "center" | "right";
  readonly vertical?: "top" | "center" | "bottom";
  readonly wrap?: boolean;
  readonly borderTop?: BorderLine;
  readonly borderBottom?: BorderLine;
  readonly borderLeft?: BorderLine;
  readonly borderRight?: BorderLine;
  /** A web or mail address the cell opens, as Excel's hyperlinks. */
  readonly link?: string;
}

/** How a cell's edge is drawn, as Excel's common line styles; thin by default. */
export type BorderStyle = "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
/** One edge of a cell: its line, and its colour as `#RRGGBB` (absent, the text's default). */
export interface BorderLine {
  readonly style: BorderStyle;
  readonly color?: string;
}

// Style keys are canonical JSON shared by every cell with that style: read once each.
const read = new Map<string, CellStyle>();
const STYLES_KEPT = 5_000;
/** The style a key holds; shared, so never changed in place. */
export const cellStyle = (key: string | undefined): CellStyle => {
  if (!key) return {};
  let style = read.get(key);
  if (!style) {
    // Keys are written only by `styleKey`.
    style = Object.freeze(JSON.parse(key) as CellStyle);
    // The cache is bounded, not kept for the page's lifetime.
    if (read.size >= STYLES_KEPT) read.clear();
    read.set(key, style);
  }
  return style;
};

/** A value with every object's keys in a fixed order, so equal values write equal JSON. */
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, ordered((value as Record<string, unknown>)[key])]),
        )
      : value;

/** A style's key: its properties in a fixed order, so equal styles share one key. */
export const styleKey = (style: CellStyle) =>
  Object.keys(style).length ? JSON.stringify(ordered(style)) : undefined;
