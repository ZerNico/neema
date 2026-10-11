import type { DrawingItem } from "@office-kit/xlsx/drawing";
import { getColumnDimension, getRowDimension, type Worksheet } from "@office-kit/xlsx/worksheet";

export const EMU_PER_PIXEL = 9_525;
/** Excel's default column width and row height in pixels. */
const [COLUMN_PX, ROW_PX] = [64, 20];

/** A column's width in pixels, as Excel draws its width in characters; 0-based. */
const columnPx = (sheet: Worksheet, col: number) => {
  const dimension = getColumnDimension(sheet, col + 1);
  if (dimension?.hidden) return 0;
  return dimension?.width === undefined ? COLUMN_PX : Math.round(dimension.width * 7 + 5);
};
/** A row's height in pixels, from its height in points; 0-based. */
const rowPx = (sheet: Worksheet, row: number) => {
  const dimension = getRowDimension(sheet, row + 1);
  if (dimension?.hidden) return 0;
  return dimension?.height === undefined ? ROW_PX : Math.round((dimension.height * 4) / 3);
};

/**
 * A drawing's size in pixels. One anchored at a cell carries it; one
 * stretched between two cells spans the sheet's own widths and heights.
 */
export function anchorSize(
  sheet: Worksheet,
  anchor: Exclude<DrawingItem["anchor"], { kind: "absolute" }>,
): [number, number] {
  if (anchor.kind === "oneCell")
    return [anchor.ext.cx / EMU_PER_PIXEL, anchor.ext.cy / EMU_PER_PIXEL];
  const { from, to } = anchor;
  let [width, height] = [0, 0];
  for (let col = from.col; col < to.col; col++) width += columnPx(sheet, col);
  for (let row = from.row; row < to.row; row++) height += rowPx(sheet, row);
  return [
    width + (to.colOff - from.colOff) / EMU_PER_PIXEL,
    height + (to.rowOff - from.rowOff) / EMU_PER_PIXEL,
  ];
}
