import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import type { ChatDelta } from "./gateway.ts";
import { extractThinkTags } from "./think-extractor.ts";

const run = (deltas: ChatDelta[]) =>
  Effect.map(Stream.runCollect(extractThinkTags(Stream.fromIterable(deltas))), (chunks) =>
    Array.from(chunks),
  );

const text = (t: string): ChatDelta => ({ kind: "text", text: t });
const reasoning = (t: string): ChatDelta => ({ kind: "reasoning", text: t });

describe("extractThinkTags", () => {
  it.effect("routes think blocks to the reasoning track", () =>
    Effect.gen(function* () {
      const out = yield* run([text("<think>hmm</think>Answer")]);
      expect(out).toEqual([reasoning("hmm"), text("Answer")]);
    }),
  );

  it.effect("handles tags split across chunk boundaries", () =>
    Effect.gen(function* () {
      const out = yield* run([text("<th"), text("ink>deep "), text("thought</th"), text("ink>Hi")]);
      const joined = { reasoning: "", text: "" };
      for (const d of out) joined[d.kind === "reasoning" ? "reasoning" : "text"] += d.text;
      expect(joined).toEqual({ reasoning: "deep thought", text: "Hi" });
    }),
  );

  it.effect("passes plain text through untouched", () =>
    Effect.gen(function* () {
      const out = yield* run([text("Hello "), text("world")]);
      expect(out).toEqual([text("Hello "), text("world")]);
    }),
  );

  it.effect("leaves provider-tagged reasoning deltas alone", () =>
    Effect.gen(function* () {
      const out = yield* run([reasoning("native"), text("answer")]);
      expect(out).toEqual([reasoning("native"), text("answer")]);
    }),
  );

  it.effect("treats an unterminated think block as reasoning to the end", () =>
    Effect.gen(function* () {
      const out = yield* run([text("<think>never closed"), text(" still going")]);
      const joined = out.map((d) => `${d.kind}:${d.text}`).join("|");
      expect(joined).toBe("reasoning:never closed|reasoning: still going");
    }),
  );

  it.effect("flushes a trailing partial tag as literal text at stream end", () =>
    Effect.gen(function* () {
      const out = yield* run([text("Answer <thin")]);
      const joinedText = out
        .filter((d) => d.kind === "text")
        .map((d) => d.text)
        .join("");
      expect(joinedText).toBe("Answer <thin");
    }),
  );

  it.effect("handles text before the think block", () =>
    Effect.gen(function* () {
      const out = yield* run([text("Pre <think>mid</think> post")]);
      expect(out).toEqual([text("Pre "), reasoning("mid"), text(" post")]);
    }),
  );
});
