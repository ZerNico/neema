import { positions, type AxisEntry, type AxisProps } from "@chat/sheet/model";

/** Excel's defaults on screen: a row of 15 points, a column of 8.43 characters. */
export const ROW_PX = 20;
export const COLUMN_PX = 64;
export const HEADER_ROW_PX = 24;
/** The outline gutter's width per level. */
export const OUTLINE_STEP = 14;
export const HEADER_COLUMN_PX = 48;

/** A row's stored height is in points, a column's width in characters, as Excel keeps them. */
export const rowPx = (props: AxisProps | undefined) =>
  props?.hidden ? 0 : props?.size === undefined ? ROW_PX : Math.round((props.size * 4) / 3);
export const columnPx = (props: AxisProps | undefined) =>
  props?.hidden ? 0 : props?.size === undefined ? COLUMN_PX : Math.round(props.size * 7 + 5);

/** One axis laid out: each live entry's start, so a pixel finds its row or column. */
export interface AxisLayout {
  readonly ids: readonly string[];
  /** `starts[i]` is where entry i begins; `starts[ids.length]` is the total. */
  readonly starts: Float64Array;
  readonly total: number;
  /** The entry covering a pixel, clamped to the axis. */
  indexAt(px: number): number;
  size(index: number): number;
}

export function axisLayout(
  entries: readonly AxisEntry[],
  props: Readonly<Record<string, AxisProps>>,
  measure: (props: AxisProps | undefined) => number,
): AxisLayout {
  const { ids } = positions(entries);
  const starts = new Float64Array(ids.length + 1);
  for (let index = 0; index < ids.length; index++)
    starts[index + 1] = starts[index]! + measure(props[ids[index]!]);
  const total = starts[ids.length]!;
  return {
    ids,
    starts,
    total,
    indexAt: (px) => {
      let [low, high] = [0, ids.length - 1];
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle]! <= px) low = middle;
        else high = middle - 1;
      }
      return Math.max(0, low);
    },
    size: (index) => starts[index + 1]! - starts[index]!,
  };
}

/**
 * An axis as the grid draws it: IDs a filter or a collapsed group hides
 * measure as hidden ones do, without being stored so.
 */
export function drawnLayout(
  entries: readonly AxisEntry[],
  props: Readonly<Record<string, AxisProps>>,
  hidden: Iterable<string>,
  measure: (props: AxisProps | undefined) => number,
): AxisLayout {
  let shown = props;
  for (const id of hidden) {
    if (shown === props) shown = { ...props };
    (shown as Record<string, AxisProps>)[id] = { ...props[id], hidden: true };
  }
  return axisLayout(entries, shown, measure);
}

/** The entries a viewport shows, with a few beyond each edge so scrolling never shows a gap. */
export function visibleRange(layout: AxisLayout, from: number, length: number, overscan = 4) {
  if (!layout.ids.length) return { first: 0, last: -1 };
  return {
    first: Math.max(0, layout.indexAt(from) - overscan),
    last: Math.min(layout.ids.length - 1, layout.indexAt(from + length) + overscan),
  };
}

let measurer: OffscreenCanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
/**
 * How wide text draws in a cell, in pixels: measured on a canvas where there
 * is one, else estimated at an average character's width.
 */
export function textWidth(text: string, fontPx = 14, bold = false): number {
  const key = `${fontPx}|${bold ? 1 : 0}|${text}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  measurer ??=
    typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  let width = text.length * fontPx * 0.55;
  if (measurer) {
    measurer.font = `${bold ? 600 : 400} ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
    width = measurer.measureText(text).width;
  }
  // A long sheet measures the same few thousand texts again and again.
  if (widths.size > 5_000) widths.clear();
  widths.set(key, width);
  return width;
}
