import { Stream } from "effect";
import type { ChatDelta } from "./gateway.ts";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

// Longest suffix of `text` that is a prefix of `tag` (a potentially
// incomplete tag split across chunk boundaries).
function partialTagSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

// Streaming extractor for models that emit raw <think>…</think> blocks in
// their text output (DeepSeek R1 distills, QwQ, many local models) instead of
// a dedicated reasoning field. Rewrites text deltas so think content flows
// through the reasoning track — same idea as the AI SDK's
// extractReasoningMiddleware, but over our ChatDelta stream. Deltas already
// tagged as reasoning by the provider pass through untouched. Tags split
// across chunk boundaries are buffered until decidable.
export function extractThinkTags<E, R>(
  source: Stream.Stream<ChatDelta, E, R>,
): Stream.Stream<ChatDelta, E, R> {
  let inThink = false;
  let pending = "";

  const process = (input: string): ChatDelta[] => {
    const out: ChatDelta[] = [];
    let text = pending + input;
    pending = "";

    while (text.length > 0) {
      const tag = inThink ? CLOSE_TAG : OPEN_TAG;
      const idx = text.indexOf(tag);
      if (idx !== -1) {
        const before = text.slice(0, idx);
        if (before) out.push({ kind: inThink ? "reasoning" : "text", text: before });
        inThink = !inThink;
        text = text.slice(idx + tag.length);
        continue;
      }
      // No full tag: hold back a trailing partial tag, emit the rest.
      const hold = partialTagSuffix(text, tag);
      const emit = hold > 0 ? text.slice(0, -hold) : text;
      pending = hold > 0 ? text.slice(-hold) : "";
      if (emit) out.push({ kind: inThink ? "reasoning" : "text", text: emit });
      break;
    }
    return out;
  };

  const flush = (): ChatDelta[] => {
    if (!pending) return [];
    const rest: ChatDelta = { kind: inThink ? "reasoning" : "text", text: pending };
    pending = "";
    return [rest];
  };

  return source.pipe(
    Stream.map((delta): ChatDelta[] =>
      delta.kind === "reasoning" ? [delta] : process(delta.text),
    ),
    // Emit anything still buffered (e.g. a lone "<thin" at stream end).
    Stream.concat(Stream.fromIterable([0]).pipe(Stream.map(() => flush()))),
    Stream.flattenIterable,
  );
}
