import { PROJECT_FILE_LIMITS } from "~/modules/projects/files.ts";

/**
 * The parser buffers a whole body before a handler sees it, so a size check in
 * the handler comes too late: one multi-gigabyte POST would exhaust the process.
 * The largest upload (a project file) plus room for its multipart framing.
 */
export const MAX_SERVER_FN_BODY = PROJECT_FILE_LIMITS.fileBytes + 1024 * 1024;

/** The refusal for a body too large to read, judged by its declared length, or null. */
export const oversizedBody = (request: Request): Response | null => {
  if (request.body === null) return null;
  const declared = request.headers.get("content-length");
  if (declared === null) return new Response("Length required", { status: 411 });
  const length = Number(declared);
  return Number.isSafeInteger(length) && length <= MAX_SERVER_FN_BODY
    ? null
    : new Response("Request is too large", { status: 413 });
};
