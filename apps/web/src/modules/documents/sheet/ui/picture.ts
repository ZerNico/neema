import { IMAGE_LIMITS } from "@chat/sheet/model/image";

const KINDS = /^image\/(png|jpeg|gif|webp)$/;
/** How large a new picture shows at first, before anyone resizes it. */
const FIRST = { width: 480, height: 360 };

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("unreadable")));
    reader.readAsDataURL(blob);
  });

/**
 * A picture as a sheet keeps one: downscaled to its longest side, then as
 * PNG (keeping transparency) or, when that is too large, JPEG at falling
 * quality, halving its size until it fits. Null for a file that is not a
 * picture a sheet takes, or cannot be read.
 */
export async function pictureOf(
  file: Blob,
): Promise<{ src: string; width: number; height: number } | null> {
  if (!KINDS.test(file.type)) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const ratio = bitmap.width / bitmap.height || 1;
  let side = Math.min(IMAGE_LIMITS.side, Math.max(bitmap.width, bitmap.height));
  for (let round = 0; round < 4; round++, side = Math.round(side / 2)) {
    const scale = side / Math.max(bitmap.width, bitmap.height);
    const [width, height] = [
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    ];
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
    for (const options of [
      { type: "image/png" },
      { type: "image/jpeg", quality: 0.85 },
      { type: "image/jpeg", quality: 0.7 },
    ]) {
      const src = await dataUrl(await canvas.convertToBlob(options));
      if (src.length > IMAGE_LIMITS.src) continue;
      bitmap.close();
      // It shows at most the first size, its proportions kept.
      const fit = Math.min(1, FIRST.width / width, FIRST.height / height);
      return {
        src,
        width: Math.max(IMAGE_LIMITS.width.min, Math.round(width * fit)),
        height: Math.max(IMAGE_LIMITS.height.min, Math.round((width * fit) / ratio)),
      };
    }
  }
  bitmap.close();
  return null;
}
