import { Effect, Schema } from "effect";
import { Prompt, Tool, Toolkit } from "effect/ai";
import { describe, expect } from "vitest";
import { roundPrompt } from "./replay.ts";
import { effect, harness, messagesSse, textOf } from "./test-harness.ts";

// Synthetic fixtures following Anthropic's documented Messages event stream.

const start = (usage: Record<string, unknown> = { input_tokens: 10 }) => ({
  type: "message_start",
  message: { id: "msg_1", model: "anthropic.claude-sonnet-5", usage },
});
const text = (index: number, value: string) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index },
];
const thinking = (index: number, value: string, signature: string) => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: value } },
  { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
  { type: "content_block_stop", index },
];
const toolUse = (index: number, id: string, json: string) => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name: "lookup", input: {} },
  },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } },
  { type: "content_block_stop", index },
];
const stop = (reason: string, usage: Record<string, unknown> = { output_tokens: 5 }) => [
  { type: "message_delta", delta: { stop_reason: reason }, usage },
  { type: "message_stop" },
];

const lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ query: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ found: Schema.Number }),
});
const toolkit = Toolkit.make(lookup).pipe(
  Effect.provide(Toolkit.make(lookup).toLayer({ lookup: () => Effect.succeed({ found: 3 }) })),
);

const CLAUDE = "anthropic.claude-sonnet-5";
const bedrock = (answers: ReadonlyArray<string>, call: Record<string, unknown> = {}) =>
  harness({
    preset: "bedrock",
    baseUrl: "us-east-1",
    call: { model: CLAUDE, ...call },
    answers,
  });

describe("Messages routing", () => {
  effect("sends Claude to the Messages API and every other model to Chat Completions", () =>
    Effect.gen(function* () {
      const claude = bedrock([messagesSse([start(), ...text(0, "Hi"), ...stop("end_turn")])], {
        model: "us.anthropic.claude-sonnet-5",
      });
      const parts = yield* claude.stream("Hello");
      expect(textOf(parts)).toBe("Hi");
      // Runtime, not mantle: only runtime takes inference profiles.
      expect(claude.exchanges[0]!.url).toBe(
        "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages",
      );
      expect(claude.exchanges[0]!.headers).toMatchObject({
        "x-api-key": "sk-test",
        "anthropic-version": "2023-06-01",
      });
      expect(claude.exchanges[0]!.headers).not.toHaveProperty("authorization");

      const gpt = bedrock(
        ['data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n'],
        { model: "openai.gpt-oss-120b" },
      );
      yield* gpt.stream("Hello");
      expect(gpt.exchanges[0]!.url).toBe(
        "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions",
      );
      expect(gpt.exchanges[0]!.headers["authorization"]).toBe("Bearer sk-test");
    }),
  );

  effect("signs with AWS access keys instead of sending a key", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "bedrock",
        baseUrl: "eu-central-1",
        settings: { auth: "aws" },
        credentials: { kind: "aws", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
        call: { model: "eu.anthropic.claude-opus-5-5" },
        answers: [messagesSse([start(), ...text(0, "Hi"), ...stop("end_turn")])],
      });
      yield* run.stream("Hello");
      expect(run.exchanges[0]!.body["model"]).toBe("eu.anthropic.claude-opus-5-5");
      const headers = run.exchanges[0]!.headers;
      expect(run.exchanges[0]!.url).toBe(
        "https://bedrock-runtime.eu-central-1.amazonaws.com/anthropic/v1/messages",
      );
      expect(headers["authorization"]).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
      );
      expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
      expect(headers).not.toHaveProperty("x-api-key");
    }),
  );

  effect("sends every inference profile of Claude to runtime, whatever the base URL", () =>
    Effect.gen(function* () {
      for (const [baseUrl, model] of [
        ["eu-central-1", "eu.anthropic.claude-opus-5-5"],
        ["https://bedrock-mantle.eu-central-1.api.aws/v1", "global.anthropic.claude-opus-5-5"],
        [
          "https://bedrock-runtime.eu-central-1.amazonaws.com/openai/v1",
          "anthropic.claude-opus-5-5",
        ],
      ] as const) {
        const run = harness({
          preset: "bedrock",
          baseUrl,
          call: { model },
          answers: [messagesSse([start(), ...text(0, "Hi"), ...stop("end_turn")])],
        });
        yield* run.stream("Hello");
        expect(run.exchanges[0]!.url).toBe(
          "https://bedrock-runtime.eu-central-1.amazonaws.com/anthropic/v1/messages",
        );
      }
    }),
  );
});

describe("Messages requests", () => {
  effect("hoists system text, merges a tool result with the next user turn and caps markers", () =>
    Effect.gen(function* () {
      const run = bedrock([messagesSse([start(), ...text(0, "Ok"), ...stop("end_turn")])]);
      const anchor = { cache: { anchor: true } };
      yield* run.stream(
        Prompt.fromMessages([
          Prompt.makeMessage("system", { content: "Rules", options: anchor }),
          ...["One", "Two", "Three", "Four"].flatMap((question) => [
            Prompt.makeMessage("user", {
              content: [Prompt.makePart("text", { text: question })],
              options: anchor,
            }),
            Prompt.makeMessage("assistant", {
              content: [Prompt.makePart("text", { text: "Answer" })],
            }),
          ]),
          Prompt.makeMessage("assistant", {
            content: [
              Prompt.makePart("tool-call", {
                id: "toolu_1",
                name: "lookup",
                params: { query: "x" },
                providerExecuted: false,
              }),
            ],
          }),
          Prompt.makeMessage("tool", {
            content: [
              Prompt.makePart("tool-result", {
                id: "toolu_1",
                name: "lookup",
                isFailure: false,
                providerExecuted: false,
                result: { found: 3 },
              }),
            ],
          }),
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "More" })] }),
        ]),
      );
      const body = run.exchanges[0]!.body;
      expect(body).toMatchObject({ model: CLAUDE, max_tokens: 32_000, stream: true });
      expect(body["system"]).toEqual([
        { type: "text", text: "Rules", cache_control: { type: "ephemeral" } },
      ]);
      const messages = body["messages"] as Array<{ role: string; content: unknown[] }>;
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
      // Answer then the call: consecutive assistant turns are one.
      expect(messages[7]!.content).toEqual([
        { type: "text", text: "Answer" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { query: "x" } },
      ]);
      expect(messages[8]!.content).toEqual([
        { type: "tool_result", tool_use_id: "toolu_1", content: '{"found":3}' },
        { type: "text", text: "More" },
      ]);
      // Five anchors: the system prompt and the latest three get one.
      const markedCount = JSON.stringify(body).match(/cache_control/g)?.length;
      expect(markedCount).toBe(4);
      expect(JSON.stringify(messages[0])).not.toContain("cache_control");
    }),
  );

  effect("asks for summarised adaptive thinking at the chosen effort", () =>
    Effect.gen(function* () {
      const run = bedrock([messagesSse([start(), ...text(0, "Ok"), ...stop("end_turn")])], {
        capabilities: { reasoning: true, tools: true },
        reasoningEffort: "high",
        maxOutputTokens: 4000,
      });
      yield* run.stream("Q");
      expect(run.exchanges[0]!.body).toMatchObject({
        max_tokens: 4000,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      });
      const plain = bedrock([messagesSse([start(), ...text(0, "Ok"), ...stop("end_turn")])]);
      yield* plain.stream("Q");
      expect(plain.exchanges[0]!.body).not.toHaveProperty("thinking");
      expect(plain.exchanges[0]!.body).not.toHaveProperty("output_config");
    }),
  );
});

describe("Messages stream", () => {
  effect("streams thinking and text, runs the call and merges usage from both ends", () =>
    Effect.gen(function* () {
      const run = bedrock([
        messagesSse([
          start({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 }),
          ...thinking(0, "Plan.", "sig-1"),
          ...text(1, "Checking."),
          ...toolUse(2, "toolu_1", '{"query":"x"}'),
          ...stop("tool_use", { output_tokens: 7 }),
        ]),
      ]);
      const parts = yield* run.stream("Look", yield* toolkit);
      // Each tool asks for its arguments as they are written.
      expect(run.exchanges[0]!.body["tools"]).toMatchObject([
        { name: "lookup", eager_input_streaming: true },
      ]);
      expect(textOf(parts, "reasoning-delta")).toBe("Plan.");
      expect(textOf(parts)).toBe("Checking.");
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
        id: "toolu_1",
        name: "lookup",
        params: { query: "x" },
      });
      expect(parts.find((part) => part.type === "finish")).toMatchObject({
        reason: "tool-calls",
        usage: {
          inputTokens: { total: 105, cacheRead: 90, cacheWrite: 5, uncached: 10 },
          outputTokens: { total: 7 },
        },
      });
    }),
  );

  effect("never runs a call cut off by the token limit", () =>
    Effect.gen(function* () {
      const run = bedrock([
        messagesSse([start(), ...toolUse(0, "toolu_1", '{"query":'), ...stop("max_tokens")]),
      ]);
      const parts = yield* run.stream("Look", yield* toolkit);
      expect(parts.some((part) => part.type === "tool-call")).toBe(false);
      expect(parts.find((part) => part.type === "finish")).toMatchObject({ reason: "length" });
    }),
  );

  effect("fails a stream that ends before the message stops", () =>
    Effect.gen(function* () {
      const run = bedrock([messagesSse([start(), ...text(0, "Partial")])]);
      const result = yield* Effect.result(run.stream("Q"));
      expect(result._tag).toBe("Failure");
    }),
  );
});

describe("Messages replay", () => {
  effect("sends signed thinking back before its call on the next round", () =>
    Effect.gen(function* () {
      const run = bedrock([
        messagesSse([
          start(),
          ...thinking(0, "Plan.", "sig-1"),
          ...toolUse(1, "toolu_1", '{"query":"x"}'),
          ...stop("tool_use"),
        ]),
        messagesSse([start(), ...text(0, "Found 3."), ...stop("end_turn")]),
      ]);
      const first = yield* run.stream("Look", yield* toolkit);
      yield* run.stream(Prompt.concat(Prompt.make("Look"), roundPrompt(first)), yield* toolkit);
      const messages = run.exchanges[1]!.body["messages"] as Array<{ content: unknown[] }>;
      expect(messages[1]!.content).toEqual([
        { type: "thinking", thinking: "Plan.", signature: "sig-1" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { query: "x" } },
      ]);
    }),
  );

  effect("drops signed thinking beside text that changed since", () =>
    Effect.gen(function* () {
      const run = bedrock([
        messagesSse([start(), ...thinking(0, "Plan.", "sig"), ...text(1, "Original")]).concat(
          messagesSse(stop("end_turn")),
        ),
        messagesSse([start(), ...text(0, "Ok"), ...stop("end_turn")]),
      ]);
      const first = yield* run.stream("Q");
      const assistant = roundPrompt(first).content[0]!;
      if (assistant.role !== "assistant") throw new Error("expected an answer");
      const edited = Prompt.fromMessages([
        Prompt.makeMessage("assistant", {
          ...assistant,
          content: [Prompt.makePart("text", { text: "Edited" })],
        }),
      ]);
      yield* run.stream(Prompt.concat(Prompt.make("Q"), edited));
      const messages = run.exchanges[1]!.body["messages"] as Array<{ content: unknown[] }>;
      expect(messages[1]!.content).toEqual([{ type: "text", text: "Edited" }]);
    }),
  );
});

describe("Bedrock's OpenAI models", () => {
  const chat = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  const run = (model: string, reasoningEffort: string | null) =>
    harness({
      preset: "bedrock",
      baseUrl: "us-east-1",
      call: { model, capabilities: { reasoning: true, tools: true }, reasoningEffort },
      answers: [chat],
    });

  effect("refuse GPT-5.4+ with tools and reasoning before sending, and nothing else", () =>
    Effect.gen(function* () {
      const refused = run("us.openai.gpt-5.6-sol", "high");
      const error = yield* refused.stream("Look", yield* toolkit).pipe(Effect.flip);
      expect(error.message).toContain("turn reasoning off for this model");
      expect(refused.exchanges).toHaveLength(0);

      for (const allowed of [
        run("us.openai.gpt-5.6-sol", null),
        run("openai.gpt-oss-120b", "high"),
      ]) {
        yield* allowed.stream("Look", yield* toolkit);
        expect(allowed.exchanges).toHaveLength(1);
      }
    }),
  );
});
