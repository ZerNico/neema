import { Prompt } from "effect/unstable/ai";
import { sourceTarget } from "~/modules/tools/sources.ts";
import type { Source } from "~/modules/tools/schema.ts";
import { estimatePromptTokens } from "../compaction.ts";

export interface EvidenceBlock {
  label: string;
  text: string;
}

export const evidenceTokens = (text: string) =>
  estimatePromptTokens([{ role: "assistant", content: text }]);

/** A manifest describes evidence already present; it never expands URL authority. */
export function evidenceManifest(text: string, sources: ReadonlyArray<Source>): string {
  const cited = new Set([...text.matchAll(/\[\^?(\d+)\]/g)].map((match) => Number(match[1])));
  return sources
    .filter(
      (source) =>
        cited.has(source.index) || (source.kind !== "document" && text.includes(source.url)),
    )
    .map(
      (source) =>
        `[${source.index}] ${source.title} — ${sourceTarget(source)}${source.read ? (source.kind === "document" ? " (document excerpt read)" : " (page extracted)") : " (snippet only)"}`,
    )
    .join("\n");
}

export function boundedSourceManifest(sources: ReadonlyArray<Source>, maxTokens: number): string {
  // oxlint-disable-next-line no-array-sort -- fresh array
  const ordered = [...sources].sort((a, b) => Number(b.read) - Number(a.read) || a.index - b.index);
  const all = ordered.map((source) => evidenceManifest(`[^${source.index}]`, [source]));
  if (evidenceTokens(all.join("\n")) <= maxTokens) return all.join("\n");
  const omitted =
    "Additional source metadata omitted; retain the citation handles in the evidence.";
  if (evidenceTokens(omitted) > maxTokens) return "";
  const lines: string[] = [];
  for (const line of all) {
    if (evidenceTokens([...lines, line, omitted].join("\n")) <= maxTokens) lines.push(line);
  }
  return [...lines, omitted].join("\n");
}

const excerpt = (text: string, cap: number) => {
  if (text.length <= cap) return text;
  const marker = "\n[Evidence abridged; omitted details are not established here.]\n";
  if (cap < marker.length) return "";
  const available = cap - marker.length;
  const front = Math.ceil(available * 0.7);
  return (
    text.slice(0, front).replace(/\[\^?\d*$/, "") +
    marker +
    text.slice(text.length - (available - front))
  );
};

/** Fair, deterministic fallback when summarization cannot fit the evidence. */
export function boundEvidence(
  blocks: ReadonlyArray<EvidenceBlock>,
  sources: ReadonlyArray<Source>,
  maxTokens: number,
): { text: string; abridged: boolean } {
  const render = (cap: number) => {
    const body = blocks
      .map(
        (block) =>
          `${block.label}\n${excerpt(block.text, cap) || "[Findings omitted to fit context.]"}`,
      )
      .join("\n\n");
    const manifest = evidenceManifest(body, sources);
    return manifest ? `${body}\n\nRegistered sources:\n${manifest}` : body;
  };
  let low = 0;
  let high = Math.max(0, ...blocks.map((block) => block.text.length));
  if (evidenceTokens(render(high)) <= maxTokens) return { text: render(high), abridged: false };
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (evidenceTokens(render(middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  const text = render(low);
  // Labels alone can exceed a very small allowance. Do not send a prompt that
  // failed its own fit check, or silently imply the omitted findings were read.
  return {
    text: evidenceTokens(text) <= maxTokens ? text : "",
    abridged: true,
  };
}

export const evidencePrompt = (text: string) =>
  Prompt.make(text ? [{ role: "assistant", content: text }] : []);
