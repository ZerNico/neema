import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import type { ToolActivity, ToolSource } from "../client/use-message-stream.ts";
import { mergeSources, sourceTarget } from "~/modules/tools/sources.ts";

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

  const definitions = sources.map((s) => `[^${s.index}]: ${sourceTarget(s)}`).join("\n");
  // Mid-stream the answer can end inside an unterminated code fence; without
  // this the definitions would land *inside* it and render as code.
  const openFence = (body.match(/^\s*```/gm)?.length ?? 0) % 2 === 1 ? "\n```" : "";
  return `${body}${openFence}\n\n${definitions}`;
}

/** Citation references in prose, excluding code and model-authored definitions. */
export function citedSourceIndexes(content: string): Set<number> {
  const handles = new Set([...content.matchAll(/\[\^(\d+)\]/g)].map((match) => match[1]!));
  if (!handles.size) return new Set();
  // Resolve marker-only model output with the same GFM grammar as the renderer.
  // Prefix definitions so an unfinished fence cannot swallow them; never visit
  // definition bodies, inline code, or fenced examples as answer evidence.
  const definitions = [...handles].map((handle) => `[^${handle}]: source`).join("\n");
  const tree = fromMarkdown(`${definitions}\n\n${content}`, {
    extensions: [gfmFootnote()],
    mdastExtensions: [gfmFootnoteFromMarkdown()],
  });
  const cited = new Set<number>();
  type Node = { type: string; identifier?: string; children?: ReadonlyArray<Node> };
  const visit = (node: Node) => {
    if (node.type === "footnoteDefinition") return;
    if (node.type === "footnoteReference" && node.identifier && /^\d+$/.test(node.identifier))
      cited.add(Number(node.identifier));
    node.children?.forEach(visit);
  };
  visit(tree);
  return cited;
}

export function selectAnswerSources(
  content: string,
  own: ReadonlyArray<ToolSource>,
  inherited: ReadonlyArray<ToolSource>,
): ToolSource[] {
  const cited = citedSourceIndexes(content);
  return mergeSources([
    ...own.filter((source) => source.read || cited.has(source.index)),
    ...inherited.filter((source) => cited.has(source.index)),
  ]);
}

/** Deduplicates sources by citation index, lowest first. */
export function collectSources(activities: ReadonlyArray<ToolActivity>): ToolSource[] {
  return mergeSources(
    activities.flatMap((activity) =>
      activity.family === "web" || activity.family === "research" || activity.family === "knowledge"
        ? (activity.sources ?? [])
        : [],
    ),
  );
}
