import { Effect, Schema } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect } from "vitest";
import { roundPrompt } from "./replay.ts";
import { chatSse, effect, harness, responsesSse, textOf } from "./test-harness.ts";

// Synthetic fixtures following OpenAI's documented Responses event stream.

const response = (extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  object: "response",
  model: "gpt-5.6",
  output: [],
  ...extra,
});
const created = { type: "response.created", response: response() };
const completed = (usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 }) => ({
  type: "response.completed",
  response: response({ usage }),
});
const reasoning = (index: number, encrypted: string) => ({
  type: "response.output_item.done",
  output_index: index,
  item: {
    id: `rs_${index}`,
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Plan." }],
    encrypted_content: encrypted,
    status: "completed",
  },
});
const message = (index: number, text: string, phase?: string) => [
  { type: "response.output_text.delta", item_id: `msg_${index}`, output_index: index, delta: text },
  {
    type: "response.output_item.done",
    output_index: index,
    item: {
      id: `msg_${index}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
      ...(phase ? { phase } : {}),
    },
  },
];
const functionCall = (index: number, callId: string, args: string) => [
  {
    type: "response.output_item.added",
    output_index: index,
    item: {
      id: `fc_${index}`,
      type: "function_call",
      call_id: callId,
      name: "lookup",
      arguments: "",
    },
  },
  {
    type: "response.function_call_arguments.delta",
    item_id: `fc_${index}`,
    output_index: index,
    delta: args,
  },
  {
    type: "response.output_item.done",
    output_index: index,
    item: {
      id: `fc_${index}`,
      type: "function_call",
      call_id: callId,
      name: "lookup",
      arguments: args,
    },
  },
];

const lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ query: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ found: Schema.Number }),
});
const toolkit = Toolkit.make(lookup).pipe(
  Effect.provide(Toolkit.make(lookup).toLayer({ lookup: () => Effect.succeed({ found: 3 }) })),
);
const reasoningCall = { capabilities: { reasoning: true, tools: true }, reasoningEffort: "low" };

describe("Responses requests", () => {
  effect("keeps nothing at the provider and asks for what continues reasoning", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openai",
        call: { ...reasoningCall, cacheKey: "c1", maxOutputTokens: 50 },
        answers: [responsesSse([created, ...message(0, "Hi"), completed()])],
      });
      yield* run.stream("Hello", yield* toolkit);
      expect(run.exchanges[0]!.url).toBe("https://provider.test/v1/responses");
      expect(run.exchanges[0]!.body).toMatchObject({
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "low", summary: "auto" },
        max_output_tokens: 50,
        prompt_cache_key: "c1",
        tools: [{ type: "function", name: "lookup", strict: false }],
      });
    }),
  );

  effect("retries without summaries for an organisation OpenAI has not verified", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openai",
        call: reasoningCall,
        answers: [
          {
            status: 400,
            body: JSON.stringify({
              error: {
                message: "Your organization must be verified to generate reasoning summaries.",
                type: "invalid_request_error",
              },
            }),
          },
          responsesSse([created, ...message(0, "Hi"), completed()]),
        ],
      });
      expect(textOf(yield* run.stream("Hello"))).toBe("Hi");
      expect(run.exchanges[1]!.body["reasoning"]).toEqual({ effort: "low" });
    }),
  );
});

describe("Azure deployments without Responses", () => {
  effect("move a refusing deployment to Chat Completions and report it", () =>
    Effect.gen(function* () {
      let reported = 0;
      const chat = (text: string) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      const run = harness({
        preset: "azure",
        baseUrl: "https://res.services.ai.azure.com",
        call: { onChatFallback: Effect.sync(() => void reported++) },
        answers: [
          {
            status: 400,
            body: JSON.stringify({ error: { code: "BadRequest", message: "Model not supported" } }),
          },
          chat("Hi"),
        ],
      });
      expect(textOf(yield* run.stream("Q"))).toBe("Hi");
      expect(reported).toBe(1);
      expect(run.exchanges.map((exchange) => exchange.url)).toEqual([
        "https://res.services.ai.azure.com/openai/v1/responses",
        "https://res.services.ai.azure.com/openai/v1/chat/completions",
      ]);
    }),
  );

  effect("start on the API the model has stored, and never fall back elsewhere", () =>
    Effect.gen(function* () {
      const stored = harness({
        preset: "azure",
        baseUrl: "https://res.services.ai.azure.com",
        call: { format: "chat-completions" },
        answers: [chatSse([])],
      });
      yield* stored.stream("Q");
      expect(stored.exchanges[0]!.url).toBe(
        "https://res.services.ai.azure.com/openai/v1/chat/completions",
      );
      // OpenAI has no per-model API: a stored choice is ignored, a refusal stays one.
      const openai = harness({
        preset: "openai",
        call: { format: "chat-completions" },
        answers: [
          { status: 400, body: JSON.stringify({ error: { message: "Model not supported" } }) },
        ],
      });
      yield* openai.stream("Q").pipe(Effect.flip);
      expect(openai.exchanges.map((exchange) => exchange.url)).toEqual([
        "https://provider.test/v1/responses",
      ]);
    }),
  );

  effect("keeps any other rejection as it was", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "azure",
        baseUrl: "https://res.openai.azure.com",
        call: { model: "other-rejection-test" },
        answers: [{ status: 400, body: JSON.stringify({ error: { message: "Invalid input" } }) }],
      });
      const error = yield* run.stream("Q").pipe(Effect.flip);
      expect(error.reason._tag).toBe("InvalidRequestError");
      expect(run.exchanges).toHaveLength(1);
    }),
  );
});

describe("Responses replay", () => {
  effect("sends reasoning, commentary phase and calls back as received", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openai",
        call: reasoningCall,
        answers: [
          responsesSse([
            created,
            reasoning(0, "enc-1"),
            ...message(1, "Checking.", "commentary"),
            ...functionCall(2, "call_1", '{"query":"x"}'),
            completed(),
          ]),
          responsesSse([created, ...message(0, "Found 3.", "final_answer"), completed()]),
        ],
      });
      const first = yield* run.stream("Look", yield* toolkit);
      expect(first.find((part) => part.type === "finish")).toMatchObject({ reason: "tool-calls" });
      yield* run.stream(Prompt.concat(Prompt.make("Look"), roundPrompt(first)), yield* toolkit);
      const input = run.exchanges[1]!.body["input"] as Array<Record<string, unknown>>;
      expect(input.map((item) => item["type"] ?? item["role"])).toEqual([
        "user",
        "reasoning",
        "message",
        "function_call",
        "function_call_output",
      ]);
      expect(input[1]).toMatchObject({ id: "rs_0", encrypted_content: "enc-1" });
      expect(input[2]).toMatchObject({ phase: "commentary" });
      expect(input[3]).toMatchObject({ call_id: "call_1", arguments: '{"query":"x"}' });
      expect(input[3]).not.toHaveProperty("id");
    }),
  );

  effect("rebuilds text that changed since, keeping only the reasoning as received", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "azure",
        baseUrl: "https://res.openai.azure.com",
        call: reasoningCall,
        answers: [
          responsesSse([created, reasoning(0, "enc"), ...message(1, "Original"), completed()]),
          responsesSse([created, ...message(0, "Ok"), completed()]),
        ],
      });
      const first = yield* run.stream("Q");
      const round = roundPrompt(first);
      const assistant = round.content[0]!;
      if (assistant.role !== "assistant") throw new Error("expected an answer");
      const edited = Prompt.fromMessages([
        Prompt.makeMessage("assistant", {
          ...assistant,
          content: [Prompt.makePart("text", { text: "Edited" })],
        }),
      ]);
      yield* run.stream(Prompt.concat(Prompt.make("Q"), edited));
      const input = run.exchanges[1]!.body["input"] as Array<Record<string, unknown>>;
      expect(input.slice(1)).toEqual([
        expect.objectContaining({ type: "reasoning", encrypted_content: "enc" }),
        { role: "assistant", content: "Edited" },
      ]);
    }),
  );

  effect("never runs calls from an incomplete response", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openai",
        answers: [
          responsesSse([
            created,
            ...functionCall(0, "call_1", '{"query":'),
            {
              type: "response.incomplete",
              response: response({ incomplete_details: { reason: "max_output_tokens" } }),
            } as { type: string },
          ]),
        ],
      });
      const parts = yield* run.stream("Q", yield* toolkit);
      expect(parts.some((part) => part.type === "tool-call")).toBe(false);
      expect(parts.find((part) => part.type === "finish")).toMatchObject({ reason: "length" });
    }),
  );

  effect("keeps no copy of call arguments, sending the prompt's own", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openai",
        call: reasoningCall,
        answers: [
          responsesSse([
            created,
            reasoning(0, "enc-1"),
            ...functionCall(1, "call_1", '{"query":"private draft"}'),
            completed(),
          ]),
          responsesSse([created, ...message(0, "Done."), completed()]),
        ],
      });
      const first = yield* run.stream("Q", yield* toolkit);
      const finish = first.find((part) => part.type === "finish");
      expect(JSON.stringify(finish?.metadata)).not.toContain("private draft");
      // The app redacts a call's arguments in the continuation it builds.
      const redacted = first.map((part) =>
        part.type === "tool-call" ? { ...part, params: {} } : part,
      );
      yield* run.stream(Prompt.concat(Prompt.make("Q"), roundPrompt(redacted)), yield* toolkit);
      const input = run.exchanges[1]!.body["input"] as Array<Record<string, unknown>>;
      expect(JSON.stringify(input)).not.toContain("private draft");
      expect(input.map((item) => item["type"] ?? item["role"])).toEqual([
        "user",
        "reasoning",
        "function_call",
        "function_call_output",
      ]);
      expect(input[2]).toMatchObject({ call_id: "call_1", name: "lookup", arguments: "{}" });
    }),
  );

  effect("finishes at the terminal event even when the connection stays open", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openai",
        answers: [{ open: responsesSse([created, ...message(0, "Hi"), completed()]) }],
      });
      const parts = yield* run.stream("Q");
      expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    }),
  );

  effect("runs no call when [DONE] arrives without a terminal event", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openai",
        answers: [
          responsesSse([
            created,
            functionCall(0, "call_1", '{"query":"x"}')[0]!,
            functionCall(0, "call_1", '{"query":"x"}')[1]!,
          ]) + "data: [DONE]\n\n",
        ],
      });
      let ran = false;
      const kit = Toolkit.make(lookup);
      const resolved = yield* kit.pipe(
        Effect.provide(
          kit.toLayer({ lookup: () => Effect.sync(() => ((ran = true), { found: 1 })) }),
        ),
      );
      const error = yield* run.stream("Q", resolved).pipe(Effect.flip);
      expect(error.reason._tag).toBe("NetworkError");
      expect(ran).toBe(false);
    }),
  );

  effect("fails a stream that ends without a terminal event", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openai",
        answers: [responsesSse([created, ...message(0, "Hi")])],
      });
      const error = yield* run.stream("Q").pipe(Effect.flip);
      expect(error.reason._tag).toBe("NetworkError");
    }),
  );

  effect("reports cached input from the usage details", () =>
    Effect.gen(function* () {
      const run = harness({
        preset: "openai",
        answers: [
          responsesSse([
            created,
            ...message(0, "Hi"),
            completed({
              input_tokens: 100,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 80 },
              output_tokens_details: { reasoning_tokens: 12 },
            }),
          ]),
        ],
      });
      const finish = (yield* run.stream("Q")).find((part) => part.type === "finish");
      expect(finish?.usage).toMatchObject({
        inputTokens: { total: 100, cacheRead: 80, uncached: 20 },
        outputTokens: { total: 20, reasoning: 12, text: 8 },
      });
    }),
  );
});
