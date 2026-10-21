import { code, type HighlightOptions, type HighlightResult } from "@streamdown/code";

export type HighlightRequest = { id: number; options: HighlightOptions };
export type HighlightReply = { id: number; result: HighlightResult };

/** A streamed block is a new string per token, so old results are dropped. */
const KEPT_RESULTS = 500;

const themeName = (theme: HighlightOptions["themes"][number]) =>
  typeof theme === "string" ? theme : (theme.name ?? "custom");
const keyOf = ({ code: source, language, themes }: HighlightOptions) =>
  `${language}\u0000${themeName(themes[0])}\u0000${themeName(themes[1])}\u0000${source}`;

const results = new Map<string, HighlightResult>();
const inFlight = new Map<
  number,
  { key: string; options: HighlightOptions; callbacks: Set<(result: HighlightResult) => void> }
>();
const byKey = new Map<string, number>();
let nextId = 0;
let worker: Worker | null | undefined;

function keep(key: string, result: HighlightResult) {
  results.set(key, result);
  if (results.size > KEPT_RESULTS) results.delete(results.keys().next().value!);
}

function settle(id: number) {
  const request = inFlight.get(id);
  inFlight.delete(id);
  if (request) byKey.delete(request.key);
  return request;
}

function highlighter(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") return (worker = null);
  const started = new Worker(new URL("./code-highlight.worker.ts", import.meta.url), {
    type: "module",
  });
  started.addEventListener("message", (event: MessageEvent<HighlightReply>) => {
    const request = settle(event.data.id);
    if (!request) return;
    keep(request.key, event.data.result);
    for (const callback of request.callbacks) callback(event.data.result);
  });
  // A Worker that cannot start leaves the work to the page's own highlighter.
  started.addEventListener("error", () => {
    started.terminate();
    worker = null;
    for (const id of inFlight.keys()) {
      const request = settle(id)!;
      for (const callback of request.callbacks) code.highlight(request.options, callback);
    }
  });
  return (worker = started);
}

/**
 * `@streamdown/code` with the tokenizing moved to a Worker. Same contract: a
 * known result at once, otherwise null and the callback once tokens arrive.
 */
export const workerCode: typeof code = {
  ...code,
  highlight(options, callback) {
    const target = highlighter();
    if (!target) return code.highlight(options, callback);
    const key = keyOf(options);
    const known = results.get(key);
    if (known) return known;
    const pending = byKey.get(key);
    if (pending !== undefined) {
      if (callback) inFlight.get(pending)?.callbacks.add(callback);
      return null;
    }
    const id = nextId++;
    inFlight.set(id, { key, options, callbacks: new Set(callback ? [callback] : []) });
    byKey.set(key, id);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage takes no origin
    target.postMessage({ id, options } satisfies HighlightRequest);
    return null;
  },
};
