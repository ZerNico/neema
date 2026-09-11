import { Stream } from "effect";
import { Response } from "effect/unstable/ai";
import type { ChatStreamPart } from "./gateway.ts";

// Structurally identical for text and reasoning deltas: both are the bare
// provider-metadata record.
type Metadata = Response.TextDeltaPartMetadata;

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

// Longest suffix of `text` that is a proper prefix of `tag` (a possibly
// split tag straddling a chunk boundary). Returns 0 if none.
export const partialTagSuffix = (text: string, tag: string): number => {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
};

// Always-on middleware for models that emit raw <think>…</think> blocks in
// their visible text (R1 distills, QwQ, local models): routes think content to
// the reasoning track as reasoning-delta parts. Provider-native reasoning
// parts and all non-text parts pass through untouched; a buffered partial tag
// is flushed before any non-text part so ordering is preserved.
export const extractThinkTags = <E, R>(
  source: Stream.Stream<ChatStreamPart, E, R>,
): Stream.Stream<ChatStreamPart, E, R> => {
  let inThink = false;
  let pending = "";
  let textId = "extracted-text";
  let reasoningOpen = false;

  const reasoningId = () => `${textId}-think`;

  // Built through `Response.makePart` rather than object literals: it stamps
  // the part brand and defaults `metadata` to `{}`. A part reaching
  // `Prompt.fromResponseParts` without metadata dies on `Object.entries`,
  // which is why every re-chunked delta below carries the source part's.
  const emit = (out: ChatStreamPart[], text: string, metadata: Metadata = {}) => {
    if (text.length === 0) return;
    if (inThink) {
      if (!reasoningOpen) {
        reasoningOpen = true;
        out.push(Response.makePart("reasoning-start", { id: reasoningId() }));
      }
      out.push(Response.makePart("reasoning-delta", { id: reasoningId(), delta: text, metadata }));
    } else {
      out.push(Response.makePart("text-delta", { id: textId, delta: text, metadata }));
    }
  };

  const closeReasoning = (out: ChatStreamPart[]) => {
    if (reasoningOpen) {
      reasoningOpen = false;
      out.push(Response.makePart("reasoning-end", { id: reasoningId() }));
    }
  };

  const process = (delta: string, metadata: Metadata): ChatStreamPart[] => {
    const out: ChatStreamPart[] = [];
    pending += delta;

    for (;;) {
      const tag = inThink ? CLOSE_TAG : OPEN_TAG;
      const idx = pending.indexOf(tag);
      if (idx === -1) break;
      emit(out, pending.slice(0, idx), metadata);
      pending = pending.slice(idx + tag.length);
      if (inThink) {
        inThink = false;
        closeReasoning(out);
      } else {
        inThink = true;
      }
    }

    // Hold back only a possible split tag; emit the rest.
    const hold = partialTagSuffix(pending, inThink ? CLOSE_TAG : OPEN_TAG);
    const emittable = pending.slice(0, pending.length - hold);
    pending = pending.slice(pending.length - hold);
    emit(out, emittable, metadata);
    return out;
  };

  // Flush the held-back partial tag as literal content before non-text parts
  // and at stream end, so nothing is silently dropped.
  const flushPending = (): ChatStreamPart[] => {
    if (pending.length === 0) return [];
    const out: ChatStreamPart[] = [];
    emit(out, pending);
    pending = "";
    closeReasoning(out);
    return out;
  };

  const transformed = source.pipe(
    Stream.map((part): ChatStreamPart[] => {
      if (part.type === "text-delta") {
        textId = part.id;
        return process(part.delta, part.metadata);
      }
      if (part.type === "text-start" || part.type === "text-end") {
        // Suppress while inside a think block; re-derived ids keep pairing.
        return inThink ? [] : [part];
      }
      // Any other part (reasoning, tool-call, tool-result, finish, …):
      // flush buffered text first, then pass the part through.
      return [...flushPending(), part];
    }),
    Stream.flattenIterable,
  );

  const tail = Stream.suspend(() => Stream.fromIterable(flushPending()));
  return transformed.pipe(Stream.concat(tail));
};
