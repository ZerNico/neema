import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import type { ChatStreamPart } from "./gateway.ts";
import { extractThinkTags } from "./think-extractor.ts";

const run = (parts: ChatStreamPart[]) =>
  Effect.map(Stream.runCollect(extractThinkTags(Stream.fromIterable(parts))), (chunks) =>
    Array.from(chunks),
  );

const text = (delta: string): ChatStreamPart =>
  ({ type: "text-delta", id: "t1", delta }) as ChatStreamPart;
const reasoning = (delta: string): ChatStreamPart =>
  ({ type: "reasoning-delta", id: "r1", delta }) as ChatStreamPart;

// Collapse the output to comparable {track, text} tuples, ignoring
// start/end bracketing parts.
const tracks = (parts: ChatStreamPart[]) => {
  const joined = { reasoning: "", text: "" };
  for (const p of parts) {
    if (p.type === "text-delta") joined.text += p.delta;
    else if (p.type === "reasoning-delta") joined.reasoning += p.delta;
  }
  return joined;
};

describe("extractThinkTags", () => {
  it.effect("routes think blocks to the reasoning track", () =>
    Effect.gen(function* () {
      const out = yield* run([text("<think>hmm</think>Answer")]);
      expect(tracks(out)).toEqual({ reasoning: "hmm", text: "Answer" });
    }),
  );

  it.effect("handles tags split across chunk boundaries", () =>
    Effect.gen(function* () {
      const out = yield* run([text("<th"), text("ink>deep "), text("thought</th"), text("ink>Hi")]);
      expect(tracks(out)).toEqual({ reasoning: "deep thought", text: "Hi" });
    }),
  );

  it.effect("passes plain text through untouched", () =>
    Effect.gen(function* () {
      const out = yield* run([text("Hello "), text("world")]);
      expect(tracks(out)).toEqual({ reasoning: "", text: "Hello world" });
    }),
  );

  it.effect("leaves provider-tagged reasoning deltas alone", () =>
    Effect.gen(function* () {
      const out = yield* run([reasoning("native"), text("answer")]);
      expect(tracks(out)).toEqual({ reasoning: "native", text: "answer" });
      expect(out.some((p) => p.type === "reasoning-delta")).toBe(true);
    }),
  );

  it.effect("treats an unterminated think block as reasoning to the end", () =>
    Effect.gen(function* () {
      const out = yield* run([text("<think>never closed"), text(" still going")]);
      expect(tracks(out)).toEqual({ reasoning: "never closed still going", text: "" });
    }),
  );

  it.effect("flushes a trailing partial tag as literal text at stream end", () =>
    Effect.gen(function* () {
      const out = yield* run([text("Answer <thin")]);
      expect(tracks(out).text).toBe("Answer <thin");
    }),
  );

  it.effect("handles text before the think block", () =>
    Effect.gen(function* () {
      const out = yield* run([text("Pre <think>mid</think> post")]);
      expect(tracks(out)).toEqual({ reasoning: "mid", text: "Pre  post" });
    }),
  );

  it.effect("passes non-text parts through and flushes buffered text first", () =>
    Effect.gen(function* () {
      const finish = { type: "finish", reason: "stop" } as unknown as ChatStreamPart;
      const out = yield* run([text("Done <t"), finish]);
      const finishIdx = out.findIndex((p) => p.type === "finish");
      expect(finishIdx).toBeGreaterThan(0);
      // buffered partial tag flushed as literal text BEFORE the finish part
      const before = tracks(out.slice(0, finishIdx));
      expect(before.text).toBe("Done <t");
    }),
  );
});
