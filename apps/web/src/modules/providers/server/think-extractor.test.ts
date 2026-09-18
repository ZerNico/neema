import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { Prompt, Response } from "effect/unstable/ai";
import type { ChatStreamPart } from "./gateway.ts";
import { extractThinkTags } from "./think-extractor.ts";

const run = (parts: ChatStreamPart[]) =>
  Effect.map(Stream.runCollect(extractThinkTags(Stream.fromIterable(parts))), (chunks) =>
    Array.from(chunks),
  );

// Built the way the providers' decoded stream parts are, metadata and all.
const text = (delta: string): ChatStreamPart =>
  Response.makePart("text-delta", { id: "t1", delta });
const reasoning = (delta: string): ChatStreamPart =>
  Response.makePart("reasoning-delta", { id: "r1", delta });

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

  // Regression: parts were built as bare object literals, so `metadata` was
  // undefined. Nothing noticed until a turn ended in tool calls and
  // `Prompt.fromResponseParts` folded it back in, and `Object.entries(undefined)`
  // killed the whole generation.
  it.effect("stamps metadata on every part it synthesizes", () =>
    Effect.gen(function* () {
      const out = yield* run([text("Pre <think>mid</think> post")]);
      expect(out.length).toBeGreaterThan(0);
      for (const part of out) expect(part.metadata).toBeDefined();
    }),
  );

  it.effect("carries the source delta's metadata onto the re-chunked text", () =>
    Effect.gen(function* () {
      const tagged = Response.makePart("text-delta", {
        id: "t1",
        delta: "hello",
        metadata: { openrouter: { note: "keep me" } },
      });
      const out = yield* run([tagged]);
      const delta = out.find((p) => p.type === "text-delta");
      expect(delta?.metadata).toEqual({ openrouter: { note: "keep me" } });
    }),
  );

  it.effect("produces a tool-calling turn that folds back into a prompt", () =>
    Effect.gen(function* () {
      const out = yield* run([
        Response.makePart("text-start", { id: "t1" }),
        text("Let me look that up."),
        Response.makePart("tool-call", {
          id: "call_1",
          name: "read_url",
          params: { urls: ["https://example.com"] },
          providerExecuted: false,
        }),
      ]);
      const prompt = Prompt.fromResponseParts(out);
      expect(prompt.content.map((message) => message.role)).toContain("assistant");
    }),
  );

  it.effect("passes non-text parts through and flushes buffered text first", () =>
    Effect.gen(function* () {
      const finish = { type: "finish", reason: "stop" } as ChatStreamPart;
      const out = yield* run([text("Done <t"), finish]);
      const finishIdx = out.findIndex((p) => p.type === "finish");
      expect(finishIdx).toBeGreaterThan(0);
      // buffered partial tag flushed as literal text BEFORE the finish part
      const before = tracks(out.slice(0, finishIdx));
      expect(before.text).toBe("Done <t");
    }),
  );
});
