import type { DrawingItem } from "@office-kit/xlsx/drawing";
import type { Worksheet } from "@office-kit/xlsx/worksheet";
import { SPREADSHEET_LIMITS } from "../limits.ts";
import type { SpreadsheetPreview } from "../preview.ts";
import { anchorSize, EMU_PER_PIXEL } from "./file-anchors.ts";

/** Picture formats a browser draws; others are left out of a preview. */
const KINDS = new Set(["png", "jpeg", "gif", "webp"]);
/** How far into its cell a picture's corner may sit, and how large it may draw, in pixels. */
const OFFSET = 2_000;
const SIZE = { min: 16, max: 2_000 };

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(max, Math.max(min, value)));

/**
 * A picture Excel embedded, as a preview draws it over the cells: its corner
 * cell, its size and its bytes as a data URL. Null for a kind a browser does
 * not draw, one placed by absolute position, or one too large to send.
 */
export function readImage(
  sheet: Worksheet,
  item: DrawingItem,
): SpreadsheetPreview["images"][number] | null {
  if (item.content.kind !== "picture") return null;
  const picture = item.content.picture;
  const image = picture.image;
  if (!image || !KINDS.has(image.format) || item.anchor.kind === "absolute") return null;
  const src = `data:image/${image.format};base64,${Buffer.from(image.bytes).toString("base64")}`;
  if (src.length > SPREADSHEET_LIMITS.previewImageChars) return null;
  const { anchor } = item;
  const [width, height] = anchorSize(sheet, anchor);
  return {
    row: anchor.from.row + 1,
    col: anchor.from.col + 1,
    x: clamp(anchor.from.colOff / EMU_PER_PIXEL, 0, OFFSET),
    y: clamp(anchor.from.rowOff / EMU_PER_PIXEL, 0, OFFSET),
    width: clamp(width, SIZE.min, SIZE.max),
    height: clamp(height, SIZE.min, SIZE.max),
    src,
    ...(picture.descr ? { alt: picture.descr.slice(0, 500) } : {}),
  };
}
