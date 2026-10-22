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
     * Who may read stored bytes can always change, so nothing is reused
     * unchecked. An `etag` lets the browser keep bytes that never change under
     * it, reusing them only after the route has checked access again and
     * answered `notModified`. `never` stores nothing.
     */
    readonly cache: "never" | { readonly etag: string };
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
      ...cacheHeaders(options.cache),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const cacheHeaders = (cache: "never" | { readonly etag: string }): Record<string, string> =>
  cache === "never"
    ? { "Cache-Control": "private, no-store" }
    : { "Cache-Control": "private, no-cache", ETag: cache.etag };

/** True when the browser already holds the bytes tagged `etag` (RFC 9110 weak comparison). */
export const holdsCurrent = (request: Request, etag: string) => {
  const header = request.headers.get("If-None-Match");
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((tag) => tag.trim())
    .some((tag) => tag === "*" || tag.replace(/^W\//, "") === bare);
};

/** The answer to a browser whose copy is current, sent only after access was checked again. */
export const notModified = (etag: string) =>
  new Response(null, { status: 304, headers: cacheHeaders({ etag }) });
