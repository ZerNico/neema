/** Larger than any sane tab icon; anything bigger is not worth holding as a string. */
export const FAVICON_MAX_BYTES = 64 * 1024;

/**
 * The `data:` URL for fetched icon bytes, or null when they are not an image of
 * a sensible size. SVG is allowed: shown through `<img>`, its scripts never run.
 */
export function faviconDataUrl(contentType: string | null, bytes: Uint8Array): string | null {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type.startsWith("image/") || bytes.byteLength === 0) return null;
  if (bytes.byteLength > FAVICON_MAX_BYTES) return null;
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** A page may name its icon inline; only a small image one is kept as given. */
export const inlineFavicon = (url: string) =>
  /^data:image\/[\w.+-]+[;,]/i.test(url) && url.length <= FAVICON_MAX_BYTES * 1.4 ? url : null;
