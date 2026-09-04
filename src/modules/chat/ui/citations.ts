import type { ToolActivity, ToolSource } from "../client/use-message-stream.ts";

/** Matches the href streamdown gives a GFM footnote reference. */
export const FOOTNOTE_HREF = /^#user-content-fn-(\d+)$/;

/**
 * Prepares assistant markdown for citation rendering.
 *
 * The model only writes `[^n]` markers; it never writes the definitions. We
 * append them from our own source list, which is what makes the markers resolve
 * to footnote links *during* streaming — otherwise GFM leaves an unresolved
 * `[^1]` as literal text until the definitions arrive, which for a model would
 * be at the very end of the message (or never).
 *
 * Also drops markers we can't back with a source: a half-streamed trailing
 * `[^1` (so the last few characters don't flicker) and hallucinated indexes
 * that would otherwise sit in the prose as raw text.
 */
export function prepareCitedMarkdown(content: string, sources: ReadonlyArray<ToolSource>): string {
  if (sources.length === 0) return content;

  const known = new Set(sources.map((s) => s.index));
  const body = content
    // A marker still being streamed, e.g. "…as of 2026[^1" at the very end.
    .replace(/\[\^\d*$/, "")
    // Indexes with no matching source — the model invented them.
    .replace(/\[\^(\d+)\]/g, (match, n: string) => (known.has(Number(n)) ? match : ""));

  const definitions = sources.map((s) => `[^${s.index}]: ${s.url}`).join("\n");
  // Mid-stream the answer can end inside an unterminated code fence; without
  // this the definitions would land *inside* it and render as code.
  const openFence = (body.match(/^\s*```/gm)?.length ?? 0) % 2 === 1 ? "\n```" : "";
  return `${body}${openFence}\n\n${definitions}`;
}

/** Deduplicates sources by citation index, lowest first. */
export function collectSources(activities: ReadonlyArray<ToolActivity>): ToolSource[] {
  const byIndex = new Map<number, ToolSource>();
  for (const activity of activities) {
    if (activity.family !== "web") continue;
    for (const source of activity.sources ?? []) {
      if (!byIndex.has(source.index)) byIndex.set(source.index, source);
    }
  }
  // oxlint-disable-next-line no-array-sort -- sorting a fresh copy, nothing shared to mutate
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}
