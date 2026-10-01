import { GENERIC_MEDIA_TYPE, attachmentKind } from "~/modules/attachments/constants.ts";

/**
 * Stored bytes as every file route serves them. A file's stored type is
 * descriptive only: anything but an image, a PDF or plain text goes out as
 * generic bytes, so nothing a person uploaded can render as HTML or SVG on
 * this origin, whatever the route's disposition.
 */
export function fileResponse(
  file: { readonly bytes: Uint8Array; readonly name: string; readonly mediaType: string },
  options: {
    /** Images and PDFs open in the browser; everything else downloads regardless. */
    readonly inline?: boolean;
    /**
     * `immutable` only for content addressed by an id nobody's access to can
     * change; anything whose access can be taken away is `revocable`.
     */
    readonly cache: "immutable" | "revocable";
  },
): Response {
  const kind = attachmentKind(file.mediaType);
  const mode = options.inline && (kind === "image" || kind === "pdf") ? "inline" : "attachment";
  // RFC 5987: an ASCII fallback for old agents plus the real UTF-8 name.
  const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(file.bytes as BodyInit, {
    headers: {
      "Content-Type":
        kind === "text"
          ? `${file.mediaType}; charset=utf-8`
          : kind === "file"
            ? GENERIC_MEDIA_TYPE
            : file.mediaType,
      // From the bytes actually sent, not a size column: if store and database
      // ever drift, the response must not be malformed.
      "Content-Length": String(file.bytes.byteLength),
      "Content-Disposition": `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control":
        options.cache === "immutable"
          ? "private, max-age=31536000, immutable"
          : "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
