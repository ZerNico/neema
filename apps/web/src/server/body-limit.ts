import { PROJECT_FILE_LIMITS } from "~/modules/projects/files.ts";

/**
 * The parser buffers a whole body before a handler sees it, so a size check in
 * the handler comes too late: one multi-gigabyte POST would exhaust the process.
 * The largest upload (a project file) plus room for its multipart framing.
 */
export const MAX_SERVER_FN_BODY = PROJECT_FILE_LIMITS.fileBytes + 1024 * 1024;

/** The refusal for a body whose declared length is too large to read, or null. */
export const oversizedBody = (request: Request): Response | null => {
  if (request.body === null) return null;
  const declared = request.headers.get("content-length");
  // Browsers always declare it; a proxy may forward a body chunked, and that
  // must not refuse every call behind it.
  if (declared === null) return null;
  const length = Number(declared);
  return Number.isSafeInteger(length) && length <= MAX_SERVER_FN_BODY
    ? null
    : new Response("Request is too large", { status: 413 });
};
