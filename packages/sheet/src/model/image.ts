import { isId, isRecord } from "./check.ts";
/**
 * A picture laid over a sheet, as Excel's: anchored to a cell by IDs with an
 * offset into it, at a size. Its bytes are in the document as a data URL,
 * downscaled before they are put there, so it shares the document's access,
 * undo, copies and live sync. SVG is never one: it can carry script.
 */
export interface SheetImage {
  readonly sheet: string;
  readonly at: { readonly r: string; readonly c: string };
  readonly offset?: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
  /** `data:image/png;base64,…`, or JPEG, GIF or WebP. */
  readonly src: string;
  /** Alt text, for people who cannot see it. */
  readonly alt?: string;
}

export const IMAGE_LIMITS = {
  /** Pictures in one document. */
  images: 20,
  /** Characters of one picture's data URL. */
  src: 600_000,
  /** The longest side a picture is downscaled to before it is kept. */
  side: 1_600,
  alt: 500,
  width: { min: 16, max: 2_000 },
  height: { min: 16, max: 1_600 },
} as const;

const DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

const isNumber = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** Where a picture sits and how big: what moving or resizing changes, without its bytes. */
export type ImagePlace = Pick<SheetImage, "at" | "offset" | "size">;
const PLACE_KEYS = ["at", "offset", "size"] as const;

const isPlace = (value: Record<string, unknown>) => {
  if (!isRecord(value.at) || !isRecord(value.size)) return false;
  const { width, height } = IMAGE_LIMITS;
  return (
    isId(value.at.r) &&
    isId(value.at.c) &&
    (value.offset === undefined ||
      (isRecord(value.offset) &&
        isNumber(value.offset.x, 0, 2_000) &&
        isNumber(value.offset.y, 0, 2_000))) &&
    isNumber(value.size.width, width.min, width.max) &&
    isNumber(value.size.height, height.min, height.max)
  );
};

/** Whether a picture's place, as `imagePlace` carries one, is well formed. */
export const isImagePlace = (value: unknown): value is ImagePlace =>
  isRecord(value) &&
  isPlace(value) &&
  Object.keys(value).every((key) => (PLACE_KEYS as readonly string[]).includes(key));

/** Whether a picture, as an operation carries one, is well formed. */
export function isSheetImage(value: unknown): value is SheetImage {
  if (!isRecord(value)) return false;
  return (
    isId(value.sheet) &&
    isPlace(value) &&
    typeof value.src === "string" &&
    value.src.length <= IMAGE_LIMITS.src &&
    DATA_URL.test(value.src) &&
    (value.alt === undefined ||
      (typeof value.alt === "string" && value.alt.length <= IMAGE_LIMITS.alt)) &&
    Object.keys(value).every((key) => ["sheet", "at", "offset", "size", "src", "alt"].includes(key))
  );
}
