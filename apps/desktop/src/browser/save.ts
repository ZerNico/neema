import { LIMITS } from "@chat/desktop-rpc";

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

export type SaveOutcome = { url: string; path: string } | { url: string; error: string };

/**
 * Fetches each address and lands it in the workspace, a few at a time. From
 * main, not the page, so no page's cross-origin rules apply; the session
 * `fetch` is the tab's own, so files behind its logins come too.
 */
export async function saveFiles(
  urls: ReadonlyArray<string>,
  fetchUrl: (url: string, signal: AbortSignal) => Promise<Response>,
  land: (fileName: string, bytes: Uint8Array) => Promise<string>,
): Promise<SaveOutcome[]> {
  const outcomes: SaveOutcome[] = Array.from({ length: urls.length });
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const index = next++;
      const url = urls[index]!;
      // oxlint-disable-next-line eslint/no-await-in-loop -- a few at a time, by design
      outcomes[index] = await saveOne(url, index, fetchUrl, land);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, urls.length) }, worker));
  return outcomes;
}

async function saveOne(
  url: string,
  index: number,
  fetchUrl: (url: string, signal: AbortSignal) => Promise<Response>,
  land: (fileName: string, bytes: Uint8Array) => Promise<string>,
): Promise<SaveOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_MS);
  try {
    const response = await fetchUrl(url, controller.signal);
    if (!response.ok) return { url, error: `The site answered ${response.status}.` };
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > LIMITS.importBytes) return { url, error: "It is too large to save." };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) return { url, error: "It was empty." };
    if (bytes.length > LIMITS.importBytes) return { url, error: "It is too large to save." };
    const path = await land(fileNameFor(url, response.headers.get("content-type"), index), bytes);
    return { url, path };
  } catch (error) {
    return {
      url,
      error: controller.signal.aborted
        ? "It took too long."
        : error instanceof Error
          ? error.message
          : "It could not be fetched.",
    };
  } finally {
    clearTimeout(timer);
  }
}
