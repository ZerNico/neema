import { parseCell } from "@chat/sheet/a1";
import { IMAGE_LIMITS } from "@chat/sheet/model/image";
import { addImageAt, makeOneCellAnchor, type DrawingItem } from "@office-kit/xlsx/drawing";
import type { Worksheet } from "@office-kit/xlsx/worksheet";

/**
 * Pictures as Excel files keep them: embedded bytes on a drawing, anchored
 * to a cell. Live sheets keep a picture as a data URL, so this turns one
 * into the other; kinds a live sheet does not show are left out.
 */
export interface FileImage {
  readonly sheet: string;
  readonly at: string;
  readonly offset?: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  /** The picture as a data URL, as the live sheet keeps it. */
  readonly src: string;
  readonly alt?: string;
}

const EMU_PER_PIXEL = 9_525;
/** Excel's default column width and row height, for a picture anchored across cells. */
const [COLUMN_PX, ROW_PX] = [64, 20];
const KINDS = new Set(["png", "jpeg", "gif", "webp"]);

/** Places a picture on its sheet, offset into its cell when it has one. */
export function writeImage(sheet: Worksheet, image: FileImage) {
  const parsed = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/.exec(image.src);
  const corner = parseCell(image.at);
  if (!parsed || !corner) return;
  const bytes = new Uint8Array(Buffer.from(parsed[2]!, "base64"));
  const item = addImageAt(sheet, image.at, bytes, {
    widthPx: image.width,
    heightPx: image.height,
  });
  if (item.content.kind === "picture" && image.alt) item.content.picture.descr = image.alt;
  if (image.offset)
    item.anchor = makeOneCellAnchor({
      from: {
        col: corner.column - 1,
        row: corner.row - 1,
        colOff: Math.round(image.offset.x * EMU_PER_PIXEL),
        rowOff: Math.round(image.offset.y * EMU_PER_PIXEL),
      },
      widthPx: image.width,
      heightPx: image.height,
    });
}

const cellRef = (row: number, col: number) => {
  let letters = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return `${letters}${row + 1}`;
};

/** A picture Excel wrote, as a live sheet keeps one; null for a kind it does not show or one too large. */
export function readImage(sheet: string, item: DrawingItem): FileImage | null {
  if (item.content.kind !== "picture") return null;
  const picture = item.content.picture;
  const image = picture.image;
  if (!image || !KINDS.has(image.format) || item.anchor.kind === "absolute") return null;
  const src = `data:image/${image.format};base64,${Buffer.from(image.bytes).toString("base64")}`;
  if (src.length > IMAGE_LIMITS.src) return null;
  const { anchor } = item;
  const from = anchor.from;
  const [width, height] =
    anchor.kind === "oneCell"
      ? [anchor.ext.cx / EMU_PER_PIXEL, anchor.ext.cy / EMU_PER_PIXEL]
      : [
          (anchor.to.col - from.col) * COLUMN_PX + (anchor.to.colOff - from.colOff) / EMU_PER_PIXEL,
          (anchor.to.row - from.row) * ROW_PX + (anchor.to.rowOff - from.rowOff) / EMU_PER_PIXEL,
        ];
  const { width: wide, height: tall } = IMAGE_LIMITS;
  return {
    sheet,
    at: cellRef(from.row, from.col),
    ...(from.colOff || from.rowOff
      ? {
          offset: {
            x: Math.min(2_000, Math.max(0, Math.round(from.colOff / EMU_PER_PIXEL))),
            y: Math.min(2_000, Math.max(0, Math.round(from.rowOff / EMU_PER_PIXEL))),
          },
        }
      : {}),
    width: Math.round(Math.min(wide.max, Math.max(wide.min, width))),
    height: Math.round(Math.min(tall.max, Math.max(tall.min, height))),
    src,
    ...(picture.descr ? { alt: picture.descr.slice(0, IMAGE_LIMITS.alt) } : {}),
  };
}
