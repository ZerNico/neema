import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { roundPrompt } from "./replay.ts";
import { chatSse, delta, effect, harness, textOf } from "./test-harness.ts";

// Synthetic fixtures modelled on each service's documented stream shapes.

const usage = (extra: Record<string, unknown> = {}) => ({
  ...delta({}, "stop"),
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ...extra },
});

const lookup = Tool.make("lookup", {
  description: "Look something up",
  parameters: Schema.Struct({ query: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ found: Schema.Number }),
});
const toolkit = Toolkit.make(lookup).pipe(
  Effect.provide(Toolkit.make(lookup).toLayer({ lookup: () => Effect.succeed({ found: 3 }) })),
);

describe("request shapes per preset", () => {
  const send = (
    preset: Parameters<typeof harness>[0]["preset"],
    effort: string | null,
    settings: Parameters<typeof harness>[0]["settings"] = {},
  ) =>
    Effect.gen(function* () {
      const run = harness({
        preset,
        settings,
        baseUrl: "https://provider.test/v1",
        call: { reasoningEffort: effort, maxOutputTokens: 100, cacheKey: "c1" },
        answers: [chatSse([usage()])],
      });
      yield* run.stream("Hi");
      return run.exchanges[0]!.body;
    });

  effect("sends each preset's reasoning field and nothing else", () =>
    Effect.gen(function* () {
      expect(yield* send("openrouter", "high")).toMatchObject({ reasoning: { effort: "high" } });
      expect(yield* send("groq", "high")).toMatchObject({ reasoning_effort: "high" });
      expect(yield* send("custom", "low", { reasoning: "nested" })).toMatchObject({
        reasoning: { effort: "low" },
      });
      const plain = yield* send("custom", "high");
      expect(plain).not.toHaveProperty("reasoning");
      expect(plain).not.toHaveProperty("reasoning_effort");
    }),
  );

  effect("names the output limit and cache key as each service expects", () =>
    Effect.gen(function* () {
      expect(yield* send("custom", null)).toMatchObject({ max_tokens: 100 });
      expect(yield* send("groq", null)).toMatchObject({ max_completion_tokens: 100 });
      expect(yield* send("openrouter", null)).toMatchObject({
        session_id: "c1",
        prompt_cache_key: "c1",
      });
      expect(yield* send("custom", null)).not.toHaveProperty("prompt_cache_key");
    }),
  );

  effect("leaves out stream_options where a service rejects them", () =>
    Effect.gen(function* () {
      expect(yield* send("custom", null)).toMatchObject({
        stream_options: { include_usage: true },
      });
      expect(yield* send("mistral", null)).not.toHaveProperty("stream_options");
    }),
  );

  effect("authenticates with the preset's or admin's header, or not at all", () =>
    Effect.gen(function* () {
      const azure = harness({
        preset: "azure",
        baseUrl: "https://res.openai.azure.com",
        call: { format: "chat-completions" },
        answers: [chatSse([usage()])],
      });
      yield* azure.stream("Hi");
      expect(azure.exchanges[0]!.url).toBe(
        "https://res.openai.azure.com/openai/v1/chat/completions",
      );
      expect(azure.exchanges[0]!.headers).toMatchObject({ "api-key": "sk-test" });
      expect(azure.exchanges[0]!.headers).not.toHaveProperty("authorization");

      const keyless = harness({ preset: "ollama", apiKey: null, answers: [chatSse([usage()])] });
      yield* keyless.stream("Hi");
      expect(keyless.exchanges[0]!.headers).not.toHaveProperty("authorization");
    }),
  );

  effect("asks a router in front of Claude to stream tool arguments as written", () =>
    Effect.gen(function* () {
      const claude = harness({
        preset: "custom",
        call: { model: "cc/claude-opus-5-5" },
        answers: [chatSse([usage()])],
      });
      yield* claude.stream("Hi");
      expect(claude.exchanges[0]!.headers).toMatchObject({
        "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
      });
      const other = harness({ preset: "custom", answers: [chatSse([usage()])] });
      yield* other.stream("Hi");
      expect(other.exchanges[0]!.headers).not.toHaveProperty("anthropic-beta");
    }),
  );

  effect("moves an answer's files to a user message after its tool results", () =>
    Effect.gen(function* () {
      const run = harness({ preset: "custom", answers: [chatSse([usage()])] });
      yield* run.stream(
        Prompt.make([
          { role: "user", content: "Draw" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Here" },
              { type: "file", mediaType: "image/png", data: "AAAA" },
              { type: "tool-call", id: "c1", name: "lookup", params: {} },
            ],
          },
          {
            role: "tool",
            content: [
              { type: "tool-result", id: "c1", name: "lookup", isFailure: false, result: "ok" },
            ],
          },
        ]),
      );
      const messages = run.exchanges[0]!.body["messages"] as Array<Record<string, unknown>>;
      expect(messages.map((message) => message["role"])).toEqual([
        "user",
        "assistant",
        "tool",
        "user",
      ]);
      expect(messages[1]).not.toHaveProperty("images");
      expect(JSON.stringify(messages[3])).toContain("data:image/png;base64,AAAA");
    }),
  );
});

describe("reading streams", () => {
  effect("reads reasoning from whichever field a server fills, once", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            // A relay that fills both fields with the same text.
            delta({ reasoning_content: "Thinking", reasoning: "Thinking" }),
            delta({ reasoning: " more" }),
            delta({ content: "Answer" }),
            usage(),
          ]),
        ],
      });
      const parts = yield* run.stream("Hi");
      expect(textOf(parts, "reasoning-delta")).toBe("Thinking more");
      expect(textOf(parts)).toBe("Answer");
    }),
  );

  effect("splits inline think tags across chunk boundaries", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            delta({ content: "<thi" }),
            delta({ content: "nk>plan</th" }),
            delta({ content: "ink>Done <t" }),
            usage(),
          ]),
        ],
      });
      const parts = yield* run.stream("Hi");
      expect(textOf(parts, "reasoning-delta")).toBe("plan");
      // A partial tag that never completes is text.
      expect(textOf(parts)).toBe("Done <t");
    }),
  );

  effect("treats a think tag later in the answer as the answer's text", () =>
    Effect.gen(function* () {
      const text = "R1 writes <think>plan</think> before it answers.";
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            delta({ content: text.slice(0, 12) }),
            delta({ content: text.slice(12) }),
            usage(),
          ]),
        ],
      });
      const parts = yield* run.stream("Hi");
      expect(textOf(parts)).toBe(text);
      expect(textOf(parts, "reasoning-delta")).toBe("");
    }),
  );

  effect("finds the opening block after leading whitespace, on any service", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            delta({ content: "\n <think>plan" }),
            delta({ content: "</think>Done" }),
            usage(),
          ]),
        ],
      });
      const parts = yield* run.stream("Hi");
      expect(textOf(parts, "reasoning-delta")).toBe("plan");
      expect(textOf(parts)).toBe("Done");
    }),
  );

  effect("reads Mistral's typed content chunks", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "mistral",
        answers: [
          chatSse([
            delta({ content: [{ type: "thinking", thinking: [{ type: "text", text: "Hmm" }] }] }),
            delta({ content: [{ type: "text", text: "Yes" }] }),
            usage(),
          ]),
        ],
      });
      const parts = yield* run.stream("Hi");
      expect(textOf(parts, "reasoning-delta")).toBe("Hmm");
      expect(textOf(parts)).toBe("Yes");
    }),
  );

  effect("tags a refusal as text", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [chatSse([delta({ content: null, refusal: "No." }), usage()])],
      });
      const parts = yield* run.stream("Hi");
      expect(textOf(parts)).toBe("No.");
      expect(parts.find((part) => part.type === "text-delta")?.metadata).toEqual({
        modelClient: { refusal: true },
      });
    }),
  );

  effect("finishes once, at the end, even when the finish reason repeats on the usage chunk", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openrouter",
        answers: [chatSse([delta({ content: "a" }, "stop"), usage({ cost: 0.01 })])],
      });
      const parts = yield* run.stream("Hi");
      const finishes = parts.filter((part) => part.type === "finish");
      expect(finishes).toHaveLength(1);
      expect(finishes[0]).toMatchObject({
        reason: "stop",
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
        metadata: { modelClient: { cost: 0.01 } },
      });
    }),
  );

  effect("reports unknown usage, not zero, when a server sends none", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [chatSse([delta({ content: "a" }, "stop")])],
      });
      const finish = (yield* run.stream("Hi")).find((part) => part.type === "finish");
      expect(finish?.usage.inputTokens.total).toBeUndefined();
    }),
  );

  effect("finishes at [DONE] even when the server keeps the connection open", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [{ open: chatSse([delta({ content: "a" }), usage()]) + ": keepalive\n\n" }],
      });
      const parts = yield* run.stream("Hi");
      expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    }),
  );

  effect("fails a stream that ends before any terminal signal", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [chatSse([delta({ content: "a" })], false)],
      });
      const error = yield* run.stream("Hi").pipe(Effect.flip);
      expect(error.reason._tag).toBe("NetworkError");
    }),
  );

  effect("normalises cache reads and writes in every dialect", () =>
    Effect.gen(function* () {
      const finishOf = (extra: Record<string, unknown>) =>
        Effect.gen(function* () {
          const run = harness({
            preset: "custom",
            answers: [chatSse([{ ...delta({}, "stop"), usage: extra }])],
          });
          return (yield* run.stream("Hi")).find((part) => part.type === "finish")!.usage;
        });
      // OpenAI and OpenRouter: details inside the prompt count.
      expect(
        yield* finishOf({
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
        }),
      ).toMatchObject({ inputTokens: { total: 100, cacheRead: 60, cacheWrite: 20, uncached: 20 } });
      // DeepSeek: hit and miss counts.
      expect(
        yield* finishOf({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 70 }),
      ).toMatchObject({ inputTokens: { total: 100, cacheRead: 70 } });
      // Anthropic-style through a relay: cache counts beside the prompt count.
      expect(
        yield* finishOf({
          prompt_tokens: 10,
          completion_tokens: 10,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
        }),
      ).toMatchObject({
        inputTokens: { total: 610, cacheRead: 500, cacheWrite: 100, uncached: 10 },
      });
    }),
  );
});

describe("tool calls", () => {
  effect("assembles fragmented arguments and streams their progress", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            delta({
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"que' },
                },
              ],
            }),
            delta({ tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] }),
            usage(),
          ]),
        ],
      });
      const parts = yield* run.stream("Hi", yield* toolkit);
      expect(parts.map((part) => part.type)).toEqual(
        expect.arrayContaining([
          "tool-params-start",
          "tool-params-delta",
          "tool-params-end",
          "tool-call",
          "tool-result",
        ]),
      );
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
        name: "lookup",
        params: { query: "x" },
      });
      expect(parts.find((part) => part.type === "finish")).toMatchObject({ reason: "tool-calls" });
    }),
  );

  effect("separates parallel calls a server numbers alike (Ollama)", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "ollama",
        apiKey: null,
        answers: [
          chatSse([
            delta({
              tool_calls: [
                { index: 0, id: "a", function: { name: "lookup", arguments: { query: "one" } } },
              ],
            }),
            delta({
              tool_calls: [
                { index: 0, id: "b", function: { name: "lookup", arguments: { query: "two" } } },
              ],
            }),
            usage(),
          ]),
        ],
      });
      const calls = (yield* run.stream("Hi", yield* toolkit)).filter(
        (part) => part.type === "tool-call",
      );
      expect(calls.map((call) => call.params)).toEqual([{ query: "one" }, { query: "two" }]);
    }),
  );

  effect("keeps one call when its id arrives after the call began", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            delta({ tool_calls: [{ index: 0, function: { name: "lookup", arguments: "{" } }] }),
            delta(
              { tool_calls: [{ index: 0, id: "real", function: { arguments: "}" } }] },
              "tool_calls",
            ),
            usage(),
          ]),
        ],
      });
      const calls = (yield* run.stream("Hi", yield* toolkit)).filter(
        (part) => part.type === "tool-call",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.params).toEqual({});
    }),
  );

  effect("ignores a relay repeating the whole argument string at the end", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        baseUrl: "https://relay.test/v1",
        answers: [
          chatSse([
            delta({
              tool_calls: [
                { index: 0, id: "c1", function: { name: "lookup", arguments: '{"query":"x"}' } },
              ],
            }),
            delta(
              { tool_calls: [{ index: 0, function: { arguments: '{"query":"x"}' } }] },
              "tool_calls",
            ),
            usage(),
          ]),
        ],
      });
      const call = (yield* run.stream("Hi", yield* toolkit)).find(
        (part) => part.type === "tool-call",
      );
      expect(call?.params).toEqual({ query: "x" });
    }),
  );

  effect("never runs a call cut off by the output limit", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            delta(
              {
                tool_calls: [
                  { index: 0, id: "c1", function: { name: "lookup", arguments: '{"que' } },
                ],
              },
              "length",
            ),
            usage(),
          ]),
        ],
      });
      const parts = yield* run.stream("Hi", yield* toolkit);
      expect(parts.some((part) => part.type === "tool-call")).toBe(false);
      expect(parts.find((part) => part.type === "finish")).toMatchObject({ reason: "length" });
    }),
  );

  effect("calls a tool that was not advertised, since the toolkit still has it", () =>
    Effect.gen(function* () {
      const other = Tool.make("other", { parameters: Tool.EmptyParams, success: Schema.String });
      const kit = Toolkit.make(lookup, other);
      const resolved = yield* kit.pipe(
        Effect.provide(
          kit.toLayer({
            lookup: () => Effect.succeed({ found: 1 }),
            other: () => Effect.succeed("ran"),
          }),
        ),
      );
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            delta(
              {
                tool_calls: [{ index: 0, id: "c1", function: { name: "other", arguments: "{}" } }],
              },
              "tool_calls",
            ),
            usage(),
          ]),
        ],
      });
      const parts = yield* run.stream("Hi", resolved, { oneOf: ["lookup"] });
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        name: "other",
        result: "ran",
      });
      const body = run.exchanges[0]!.body as { tools: Array<{ function: { name: string } }> };
      expect(body.tools.map((tool) => tool.function.name)).toEqual(["lookup"]);
    }),
  );
});

describe("replay", () => {
  effect("returns OpenRouter's reasoning details, merged and ordered, to the next round", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openrouter",
        answers: [
          chatSse([
            delta({
              reasoning_details: [
                {
                  type: "reasoning.text",
                  text: "Let me ",
                  index: 0,
                  format: "anthropic-claude-v1",
                },
              ],
            }),
            delta({ reasoning_details: [{ type: "reasoning.text", text: "check.", index: 0 }] }),
            delta({ reasoning_details: [{ type: "reasoning.text", signature: "sig", index: 0 }] }),
            delta(
              {
                tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: "{}" } }],
              },
              "tool_calls",
            ),
            usage(),
          ]),
          chatSse([delta({ content: "Found." }), usage()]),
        ],
      });
      const first = yield* run.stream("Look", yield* toolkit);
      expect(textOf(first, "reasoning-delta")).toBe("Let me check.");
      yield* run.stream(
        Prompt.concat(Prompt.make("Look"), Prompt.fromResponseParts(first)),
        yield* toolkit,
      );
      const assistant = (run.exchanges[1]!.body["messages"] as Array<Record<string, unknown>>)[1]!;
      expect(assistant["reasoning_details"]).toEqual([
        {
          type: "reasoning.text",
          text: "Let me check.",
          index: 0,
          format: "anthropic-claude-v1",
          signature: "sig",
        },
      ]);
    }),
  );

  effect("sends DeepSeek its reasoning back as reasoning_content", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "deepseek",
        answers: [
          chatSse([
            delta({ reasoning_content: "Need data." }),
            delta(
              {
                tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: "{}" } }],
              },
              "tool_calls",
            ),
            usage(),
          ]),
          chatSse([delta({ content: "Done." }), usage()]),
        ],
      });
      const first = yield* run.stream("Go", yield* toolkit);
      yield* run.stream(Prompt.concat(Prompt.make("Go"), roundPrompt(first)), yield* toolkit);
      const assistant = (run.exchanges[1]!.body["messages"] as Array<Record<string, unknown>>)[1]!;
      expect(assistant["reasoning_content"]).toBe("Need data.");
    }),
  );

  effect("sends reasoning_content back as received with no settings (Kimi, GLM)", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            delta({ reasoning_content: "Need data." }),
            delta(
              {
                tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: "{}" } }],
              },
              "tool_calls",
            ),
            usage(),
          ]),
          chatSse([delta({ content: "Done." }), usage()]),
        ],
      });
      const first = yield* run.stream("Go", yield* toolkit);
      yield* run.stream(Prompt.concat(Prompt.make("Go"), roundPrompt(first)), yield* toolkit);
      const assistant = (run.exchanges[1]!.body["messages"] as Array<Record<string, unknown>>)[1]!;
      expect(assistant["reasoning_content"]).toBe("Need data.");
    }),
  );

  effect("never sends a plain reasoning field back as received", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([delta({ reasoning: "Hmm." }), delta({ content: "A" }), usage()]),
          chatSse([delta({ content: "B" }), usage()]),
        ],
      });
      const first = yield* run.stream("Q");
      expect(first.find((part) => part.type === "finish")?.metadata).not.toHaveProperty(
        "modelClient.replay",
      );
      yield* run.stream(Prompt.concat(Prompt.make("Q"), roundPrompt(first)));
      const assistant = (run.exchanges[1]!.body["messages"] as Array<Record<string, unknown>>)[1]!;
      expect(Object.keys(assistant).toSorted()).toEqual(["content", "role"]);
    }),
  );

  effect("stops sending stored reasoning once switched off", () =>
    Effect.gen(function* () {
      const writer = harness({
        preset: "custom",
        answers: [
          chatSse([delta({ reasoning_content: "Plan." }), delta({ content: "A" }), usage()]),
        ],
      });
      const first = yield* writer.stream("Q");
      const reader = harness({
        preset: "custom",
        settings: { sendReasoning: false },
        answers: [chatSse([delta({ content: "B" }), usage()])],
      });
      yield* reader.stream(Prompt.concat(Prompt.make("Q"), roundPrompt(first)));
      expect(JSON.stringify(reader.exchanges[0]!.body)).not.toContain("reasoning_content");
    }),
  );

  effect("keeps Gemini's thought signatures on the calls that carried them", () =>
    Effect.gen(function* () {
      const signature = { google: { thought_signature: "sig-1" } };
      const run = harness({
        preset: "gemini",
        answers: [
          chatSse([
            delta({
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  function: { name: "lookup", arguments: "{}" },
                  extra_content: signature,
                },
              ],
            }),
            // Gemini says stop after calling a tool.
            usage(),
          ]),
          chatSse([delta({ content: "Done." }), usage()]),
        ],
      });
      const first = yield* run.stream("Go", yield* toolkit);
      expect(first.find((part) => part.type === "finish")).toMatchObject({ reason: "tool-calls" });
      yield* run.stream(Prompt.concat(Prompt.make("Go"), roundPrompt(first)), yield* toolkit);
      const assistant = (
        run.exchanges[1]!.body["messages"] as Array<{ tool_calls?: Array<Record<string, unknown>> }>
      )[1]!;
      expect(assistant.tool_calls?.[0]).toMatchObject({ id: "c1", extra_content: signature });
    }),
  );

  effect("sends nothing back to a service that rejects reasoning in history (Groq)", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "groq",
        answers: [
          chatSse([delta({ reasoning: "Hmm." }), delta({ content: "A" }), usage()]),
          chatSse([delta({ content: "B" }), usage()]),
        ],
      });
      const first = yield* run.stream("Q");
      yield* run.stream(Prompt.concat(Prompt.make("Q"), roundPrompt(first)));
      const assistant = (run.exchanges[1]!.body["messages"] as Array<Record<string, unknown>>)[1]!;
      expect(Object.keys(assistant).toSorted()).toEqual(["content", "role"]);
    }),
  );

  effect("never sends one service's state to another model", () =>
    Effect.gen(function* () {
      const writer = harness({
        preset: "openrouter",
        answers: [
          chatSse([
            delta({ reasoning_details: [{ type: "reasoning.encrypted", data: "x", index: 0 }] }),
            delta({ content: "A" }),
            usage(),
          ]),
        ],
      });
      const first = yield* writer.stream("Q");
      const reader = harness({
        preset: "openrouter",
        call: { model: "other/model" },
        answers: [chatSse([delta({ content: "B" }), usage()])],
      });
      yield* reader.stream(Prompt.concat(Prompt.make("Q"), roundPrompt(first)));
      expect(JSON.stringify(reader.exchanges[0]!.body)).not.toContain("reasoning_details");
    }),
  );
});

describe("errors", () => {
  effect("classifies a rate limit and keeps Azure's millisecond wait", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "azure",
        baseUrl: "https://res.openai.azure.com",
        call: { format: "chat-completions" },
        answers: [
          {
            status: 429,
            body: JSON.stringify({ error: { message: "Slow down", code: "429" } }),
            headers: { "retry-after-ms": "1500" },
          },
        ],
      });
      const error = yield* run.stream("Hi").pipe(Effect.flip);
      expect(error.reason._tag).toBe("RateLimitError");
      expect(error.retryAfter?.toString()).toContain("1500");
    }),
  );

  effect("keeps the provider's words for an overflow, from any error body shape", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "gemini",
        answers: [
          {
            status: 400,
            body: JSON.stringify([
              { error: { message: "The input token count exceeds the maximum context length" } },
            ]),
          },
        ],
      });
      const error = yield* run.stream("Hi").pipe(Effect.flip);
      expect(error.message).toContain("maximum context length");
    }),
  );
});
