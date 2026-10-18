// Loaded by the Word worker under plain Node in development: relative imports only.
import { imageHeader } from "../../attachments/image-header.ts";

/** A picture's type and pixel size from its own bytes; anything but PNG or JPEG is refused. */
export function pictureOf(bytes: Uint8Array) {
  const header = imageHeader(bytes);
  return header && (header.mediaType === "image/png" || header.mediaType === "image/jpeg")
    ? header
    : null;
}
