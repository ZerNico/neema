import { LIMITS } from "@chat/desktop-rpc";
import { abortable } from "./calls.ts";
import { BlockedSaveSite, fetchAllowed, receiveBytes } from "./receive.ts";

const SAVE_CONCURRENCY = 4;
const FETCH_MS = 30_000;

// File types by what a server says it sent, for an address that names none.
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "application/pdf": "pdf",
};

/** A file name for what an address served: its last path segment, typed by the response. */
export function fileNameFor(url: string, contentType: string | null, index: number): string {
  let base = "";
  try {
    base = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
  } catch {
    base = "";
  }
  base = base
    .replace(/[^\w.() -]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!base) base = `file-${index + 1}`;
  const extension = EXTENSIONS[(contentType ?? "").split(";")[0]!.trim().toLowerCase()];
  return extension && !/\.[A-Za-z0-9]{2,5}$/.test(base) ? `${base}.${extension}` : base;
}

export type SaveOutcome =
  | { url: string; path: string }
  | { url: string; error: string; blocked?: true; blockedUrl?: string };

type SaveOptions = {
  signal?: AbortSignal;
  allowed?: (url: string) => boolean;
  limit?: number;
};

/**
 * Fetches each address and lands it in the workspace, a few at a time. From
 * main, not the page, so no page's cross-origin rules apply. Requests use
 * the tab's own session, so files behind its logins come too.
 */
export async function saveFiles(
  urls: ReadonlyArray<string>,
  fetchUrl: (url: string, signal: AbortSignal) => Promise<Response>,
  land: (fileName: string, bytes: Uint8Array, signal: AbortSignal) => Promise<string>,
  options: SaveOptions = {},
): Promise<SaveOutcome[]> {
  const outcomes: SaveOutcome[] = Array.from({ length: urls.length });
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const index = next++;
      const url = urls[index]!;
      // oxlint-disable-next-line eslint/no-await-in-loop -- a few at a time, by design
      outcomes[index] = options.signal?.aborted
        ? { url, error: "The browser call ended." }
        : await saveOne(url, index, fetchUrl, land, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, urls.length) }, worker));
  return outcomes;
}

async function saveOne(
  url: string,
  index: number,
  fetchUrl: (url: string, signal: AbortSignal) => Promise<Response>,
  land: (fileName: string, bytes: Uint8Array, signal: AbortSignal) => Promise<string>,
  options: SaveOptions,
): Promise<SaveOutcome> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), FETCH_MS);
  try {
    const response = await fetchAllowed(url, fetchUrl, options.allowed ?? (() => true), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { url, error: `The site answered ${response.status}.` };
    }
    const bytes = await receiveBytes(response, options.limit ?? LIMITS.importBytes, signal);
    signal.throwIfAborted();
    if (bytes.length === 0) return { url, error: "It was empty." };
    const path = await abortable(
      land(fileNameFor(url, response.headers.get("content-type"), index), bytes, signal),
      signal,
    );
    return { url, path };
  } catch (error) {
    if (error instanceof BlockedSaveSite)
      return { url, error: error.message, blocked: true, blockedUrl: error.url };
    return {
      url,
      error: options.signal?.aborted
        ? "The browser call ended."
        : signal.aborted
          ? "It took too long."
          : error instanceof Error
            ? error.message
            : "It could not be fetched.",
    };
  } finally {
    clearTimeout(timer);
  }
}
