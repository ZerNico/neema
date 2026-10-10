import { isColor, isNumberIn, isRecord } from "./check.ts";

/** A cell's style properties, as the `format` operation writes them. */
export interface CellStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  /** A font by name; absent, the sheet's own. */
  readonly fontFamily?: string;
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
  /** A web or mail address the cell opens, as Excel's hyperlinks. */
  readonly link?: string;
}

/** Properties a format change sets, or removes with null. */
export type StylePatch = { readonly [K in keyof CellStyle]?: CellStyle[K] | null };

// Style keys are canonical JSON shared by every cell with that style: read once each.
const read = new Map<string, CellStyle>();
const STYLES_KEPT = 5_000;
/** The style a key holds; shared, so never changed in place. */
export const cellStyle = (key: string | undefined): CellStyle => {
  if (!key) return {};
  let style = read.get(key);
  if (!style) {
    // Keys are written only by `styleKey`, from checked patches.
    style = Object.freeze(JSON.parse(key) as CellStyle);
    // One process serves every document: the cache is bounded, not kept for its lifetime.
    if (read.size >= STYLES_KEPT) read.clear();
    read.set(key, style);
  }
  return style;
};

/** A style's key: its properties in a fixed order, so every replica writes the same key. */
export const styleKey = (style: CellStyle) => {
  const keys = Object.keys(style).toSorted() as Array<keyof CellStyle>;
  return keys.length
    ? JSON.stringify(Object.fromEntries(keys.map((key) => [key, style[key]])))
    : undefined;
};

/** The key of a style with a patch applied. */
export const patchStyle = (key: string | undefined, patch: StylePatch) => {
  const style: Record<string, unknown> = { ...cellStyle(key) };
  for (const [name, value] of Object.entries(patch))
    if (value === null || value === undefined) delete style[name];
    else style[name] = value;
  // Every property came from a stored style or a checked patch.
  return styleKey(style as CellStyle);
};

/**
 * The patch that turns the style at `from` into exactly `to` (a property
 * null or absent there is removed); null when they are the same.
 */
export const restyle = (from: string | undefined, to: StylePatch): StylePatch | null => {
  const had = cellStyle(from);
  const patch: Record<string, unknown> = {};
  for (const name of new Set([...Object.keys(had), ...Object.keys(to)]) as Set<keyof CellStyle>)
    if (had[name] !== (to[name] ?? undefined)) patch[name] = to[name] ?? null;
  return Object.keys(patch).length ? (patch as StylePatch) : null;
};

/**
 * Every property a cell's style may have, and what its value must be. A
 * format change carries a patch of these, each set or removed with null;
 * anything else is refused, so what is stored is always what readers draw.
 */
const flag = (value: unknown) => typeof value === "boolean";
const oneOf =
  (...options: readonly string[]) =>
  (value: unknown) =>
    typeof value === "string" && options.includes(value);
const STYLE: Readonly<Record<string, (value: unknown) => boolean>> = {
  bold: flag,
  italic: flag,
  underline: flag,
  strike: flag,
  wrap: flag,
  borderTop: flag,
  borderBottom: flag,
  borderLeft: flag,
  borderRight: flag,
  // A font's name only: nothing that could end a CSS declaration it is written into.
  fontFamily: (value) => typeof value === "string" && /^[^;{}<>"'\\\n]{1,64}$/.test(value),
  fontSize: (value) => isNumberIn(value, 1, 409),
  fontColor: isColor,
  fill: isColor,
  numberFormat: (value) => typeof value === "string" && value.length > 0 && value.length <= 255,
  horizontal: oneOf("left", "center", "right"),
  vertical: oneOf("top", "center", "bottom"),
  link: (value) =>
    typeof value === "string" && value.length <= 2_079 && /^(https?:\/\/|mailto:)/i.test(value),
};

/** Whether a format patch names only style properties, each with a value it may have or null. */
export const isStylePatch = (value: unknown): value is StylePatch =>
  isRecord(value) &&
  Object.entries(value).every(
    ([key, each]) => Object.hasOwn(STYLE, key) && (each === null || STYLE[key]!(each)),
  );
