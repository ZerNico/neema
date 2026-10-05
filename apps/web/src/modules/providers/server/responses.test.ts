import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { vi } from "vitest";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AiGateway, ProviderUnreachable } from "./gateway.ts";
import { ProviderRepo } from "./repo.ts";

// The real model client runs through the gateway; only the network is faked.
const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
let streams: Array<string | { status: number; body: string }> = [];

vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  requests.push({
    url,
    body:
      init?.body === undefined || init.body === null
        ? null
        : JSON.parse(
            typeof init.body === "string"
              ? init.body
              : new TextDecoder().decode(init.body as BufferSource),
          ),
  });
  const next = streams.shift() ?? "";
  return Promise.resolve(
    typeof next === "string"
      ? new Response(next, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(next.body, { status: next.status }),
  );
});

const events = (list: ReadonlyArray<Record<string, unknown>>) =>
  list.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const response = (extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  object: "response",
  model: "deployment",
  created_at: 1_756_000_000,
  output: [],
  ...extra,
});
const created = { type: "response.created", response: response() };
const completed = (usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 }) => ({
  type: "response.completed",
  response: response({ usage }),
});
const message = (index: number, id = "msg_1") => [
  {
    type: "response.output_item.added",
    output_index: index,
    item: { id, type: "message", role: "assistant", content: [], status: "in_progress" },
  },
];
const messageDone = (index: number, text: string, id = "msg_1") => ({
  type: "response.output_item.done",
  output_index: index,
  item: {
    id,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
    status: "completed",
  },
});
const reasoningItem = (index: number, encrypted: string) => [
  {
    type: "response.output_item.added",
    output_index: index,
    item: { id: "rs_1", type: "reasoning", summary: [] },
  },
  {
    type: "response.reasoning_summary_text.delta",
    item_id: "rs_1",
    output_index: index,
    summary_index: 0,
    delta: "Checking the docs.",
  },
  {
    type: "response.output_item.done",
    output_index: index,
    item: {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Checking the docs." }],
      encrypted_content: encrypted,
    },
  },
];

const repoWith = (kind: "openai" | "azure", reasoning: boolean) =>
  Layer.succeed(ProviderRepo)(
    ProviderRepo.of(
      Object.assign({} as ProviderRepo["Service"], {
        getModel: () =>
          Effect.succeed({
            id: "m1",
            providerId: "p1",
            modelKey: "my-deployment",
            capabilities: { reasoning, tools: true, vision: true, files: true },
          }),
        getProviderWithKey: () =>
          Effect.succeed({
            id: "p1",
            preset: kind,
            settings: {},
            apiKey: Redacted.make("sk-test"),
            baseUrl: "https://resource.test/openai/v1",
            enabled: true,
          }),
      }),
    ),
  );
const gatewayFor = (kind: "openai" | "azure", reasoning = true) =>
  AiGateway.layer.pipe(
    Layer.provide(Layer.succeed(AnalyticsRepo, { record: () => Effect.void } as never)),
    Layer.provide(repoWith(kind, reasoning)),
  );

const reset = (...bodies: typeof streams) => {
  requests.length = 0;
  streams = bodies;
};

const lookup = Tool.make("lookup", {
  description: "Look something up",
  parameters: Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Number),
  }),
  success: Schema.Struct({ found: Schema.Number }),
});
const toolkit = Toolkit.make(lookup).pipe(
  Effect.provide(Toolkit.make(lookup).toLayer({ lookup: () => Effect.succeed({ found: 3 }) })),
);

const collect = (stream: Stream.Stream<unknown, unknown>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunks) => Array.from(chunks) as never[]));

describe("Responses providers", () => {
  it.effect("asks for no stored state, encrypted reasoning, and loose tool schemas", () =>
    Effect.gen(function* () {
      reset(events([created, ...message(0), messageDone(0, "Hi"), completed()]));
      const gateway = yield* AiGateway;
      yield* collect(
        gateway.streamChat({
          modelId: "m1",
          prompt: Prompt.make("Hello"),
          toolkit: yield* toolkit,
          reasoningEffort: "high",
          maxOutputTokens: 900,
          cacheKey: "conversation-1",
        }),
      );
      const [request] = requests;
      expect(request?.url).toBe("https://resource.test/openai/v1/responses");
      expect(request?.body).toMatchObject({
        model: "my-deployment",
        store: false,
        // Asked for by the model's capability, whatever the deployment is called.
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "high", summary: "auto" },
        max_output_tokens: 900,
      });
      // Only OpenAI itself routes by cache key.
      expect(request?.body).not.toHaveProperty("prompt_cache_key");
      const tools = (request?.body?.tools ?? []) as Array<Record<string, unknown>>;
      const tool = tools[0]!;
      expect(tool).toMatchObject({ type: "function", name: "lookup", strict: false });
      // Optional keys stay optional, not rewritten into required nullable ones.
      expect((tool.parameters as { required?: unknown }).required ?? []).toEqual([]);
    }).pipe(Effect.provide(gatewayFor("azure"))),
  );

  it.effect("sends the cache key to OpenAI and no reasoning settings to a plain model", () =>
    Effect.gen(function* () {
      reset(events([created, ...message(0), messageDone(0, "Hi"), completed()]));
      const gateway = yield* AiGateway;
      yield* collect(
        gateway.streamChat({
          modelId: "m1",
          prompt: Prompt.make("Hello"),
          reasoningEffort: "high",
          cacheKey: "conversation-1",
        }),
      );
      expect(requests[0]?.body).toMatchObject({ prompt_cache_key: "conversation-1" });
      expect(requests[0]?.body).not.toHaveProperty("reasoning");
      expect(requests[0]?.body).not.toHaveProperty("include");
    }).pipe(Effect.provide(gatewayFor("openai", false))),
  );

  it.effect("asks a reasoning model for its summary even at the default effort", () =>
    Effect.gen(function* () {
      reset(events([created, ...message(0), messageDone(0, "Hi"), completed()]));
      yield* collect(
        (yield* AiGateway).streamChat({ modelId: "m1", prompt: Prompt.make("Hello") }),
      );
      expect(requests[0]?.body?.reasoning).toEqual({ summary: "auto" });
    }).pipe(Effect.provide(gatewayFor("azure"))),
  );

  it.effect("streams the answer, the reasoning summary and usage", () =>
    Effect.gen(function* () {
      reset(
        events([
          created,
          ...reasoningItem(0, "enc-1"),
          ...message(1),
          {
            type: "response.output_text.delta",
            item_id: "msg_1",
            output_index: 1,
            content_index: 0,
            delta: "Effect 4 ",
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_1",
            output_index: 1,
            content_index: 0,
            delta: "is out.",
          },
          messageDone(1, "Effect 4 is out."),
          completed(),
        ]),
      );
      const parts: Array<{ type: string; delta?: string; usage?: unknown }> = yield* collect(
        (yield* AiGateway).streamChat({ modelId: "m1", prompt: Prompt.make("News?") }),
      );
      const text = (type: string) =>
        parts.flatMap((part) => (part.type === type ? [part.delta] : [])).join("");
      expect(text("text-delta")).toBe("Effect 4 is out.");
      expect(text("reasoning-delta")).toBe("Checking the docs.");
      expect(parts.find((part) => part.type === "finish")?.usage).toMatchObject({
        inputTokens: { total: 10 },
        outputTokens: { total: 5 },
      });
    }).pipe(Effect.provide(gatewayFor("azure"))),
  );

  it.effect("shows a streamed refusal as the answer", () =>
    Effect.gen(function* () {
      reset(
        events([
          created,
          ...message(0),
          {
            type: "response.refusal.delta",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "I can’t help with that.",
          },
          completed(),
        ]),
      );
      const parts: Array<{ type: string; delta?: string }> = yield* collect(
        (yield* AiGateway).streamChat({ modelId: "m1", prompt: Prompt.make("Do something bad") }),
      );
      expect(
        parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join(""),
      ).toBe("I can’t help with that.");
    }).pipe(Effect.provide(gatewayFor("openai"))),
  );

  it.effect("carries encrypted reasoning into the next tool round", () =>
    Effect.gen(function* () {
      reset(
        events([
          created,
          ...reasoningItem(0, "enc-secret"),
          {
            type: "response.output_item.added",
            output_index: 1,
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "lookup",
              arguments: "",
              status: "in_progress",
            },
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "lookup",
              arguments: '{"query":"effect"}',
              status: "completed",
            },
          },
          completed(),
        ]),
        events([created, ...message(0), messageDone(0, "Found 3."), completed()]),
      );
      const gateway = yield* AiGateway;
      const prompt = Prompt.make("Look up effect");
      const first = yield* collect(
        gateway.streamChat({
          modelId: "m1",
          prompt,
          toolkit: yield* toolkit,
          reasoningEffort: "low",
        }),
      );
      expect(first.find((part: { type: string }) => part.type === "tool-result")).toMatchObject({
        result: { found: 3 },
      });
      yield* collect(
        gateway.streamChat({
          modelId: "m1",
          prompt: Prompt.concat(prompt, Prompt.fromResponseParts(first)),
          toolkit: yield* toolkit,
          reasoningEffort: "low",
        }),
      );
      const input = requests[1]?.body?.input as Array<Record<string, unknown>>;
      expect(input).toContainEqual(
        expect.objectContaining({ type: "reasoning", id: "rs_1", encrypted_content: "enc-secret" }),
      );
      expect(input).toContainEqual(
        expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
      );
    }).pipe(Effect.provide(gatewayFor("azure"))),
  );

  it.effect("names a streamed rate limit, without copying the provider's payload", () =>
    Effect.gen(function* () {
      reset(
        events([
          created,
          { type: "error", code: "rate_limit_exceeded", message: "Slow down", param: null },
        ]),
      );
      const error = yield* collect(
        (yield* AiGateway).streamChat({ modelId: "m1", prompt: Prompt.make("Hello") }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProviderUnreachable);
      expect((error as ProviderUnreachable).diagnostic).toEqual({ kind: "RateLimitError" });
    }).pipe(Effect.provide(gatewayFor("openai"))),
  );

  it.effect("lists Azure deployments, not the region's base models", () =>
    Effect.gen(function* () {
      reset(
        JSON.stringify({
          data: [
            { id: "chat", model: "gpt-5.6-sol", status: "succeeded", object: "deployment" },
            { id: "embed", model: "text-embedding-3-small", status: "succeeded" },
            { id: "painter", model: "dall-e-3", status: "succeeded" },
            { id: "pending", model: "gpt-4.1", status: "creating" },
          ],
        }),
      );
      const catalog = yield* (yield* AiGateway).fetchCatalog("p1");
      expect(requests.map((request) => request.url)).toEqual([
        "https://resource.test/openai/deployments?api-version=2022-12-01",
      ]);
      expect(catalog.map((model) => [model.id, model.type])).toEqual([
        ["chat", "chat"],
        ["embed", "embedding"],
      ]);
      expect(catalog[0]?.capabilities).toMatchObject({ reasoning: true, tools: true });
    }).pipe(Effect.provide(gatewayFor("azure"))),
  );

  it.effect("refuses tools with reasoning on Chat Completions for GPT-5.4 and later", () =>
    Effect.gen(function* () {
      reset();
      const error = yield* collect(
        (yield* AiGateway).streamChat({
          modelId: "m1",
          prompt: Prompt.make("Hello"),
          toolkit: yield* toolkit,
          reasoningEffort: "high",
        }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProviderUnreachable);
      expect(requests).toEqual([]);
    }).pipe(
      Effect.provide(
        AiGateway.layer.pipe(
          Layer.provide(Layer.succeed(AnalyticsRepo, { record: () => Effect.void } as never)),
          Layer.provide(
            Layer.succeed(ProviderRepo)(
              ProviderRepo.of(
                Object.assign({} as ProviderRepo["Service"], {
                  getModel: () =>
                    Effect.succeed({
                      id: "m1",
                      providerId: "p1",
                      modelKey: "gpt-5.6-sol",
                      capabilities: { reasoning: true, tools: true, vision: true, files: true },
                      // Azure's API is the deployment's own.
                      format: "chat-completions",
                    }),
                  getProviderWithKey: () =>
                    Effect.succeed({
                      id: "p1",
                      preset: "azure",
                      settings: {},
                      apiKey: Redacted.make("sk-test"),
                      baseUrl: "https://resource.test/openai/v1",
                      enabled: true,
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});

describe("Azure deployments choosing their API", () => {
  it.effect(
    "records a deployment that refused Responses, after answering on Chat Completions",
    () => {
      const recorded: Array<[string, string]> = [];
      return Effect.gen(function* () {
        reset(
          { status: 400, body: JSON.stringify({ error: { message: "Model not supported" } }) },
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
        yield* collect(
          (yield* AiGateway).streamChat({ modelId: "m1", prompt: Prompt.make("Hello") }),
        );
        expect(requests.map((request) => request.url)).toEqual([
          "https://resource.test/openai/v1/responses",
          "https://resource.test/openai/v1/chat/completions",
        ]);
        expect(recorded).toEqual([["m1", "chat-completions"]]);
      }).pipe(
        Effect.provide(
          AiGateway.layer.pipe(
            Layer.provide(Layer.succeed(AnalyticsRepo, { record: () => Effect.void } as never)),
            Layer.provide(
              Layer.succeed(ProviderRepo)(
                ProviderRepo.of(
                  Object.assign({} as ProviderRepo["Service"], {
                    getModel: () =>
                      Effect.succeed({
                        id: "m1",
                        providerId: "p1",
                        modelKey: "partner-model",
                        capabilities: {
                          reasoning: false,
                          tools: true,
                          vision: false,
                          files: false,
                        },
                        format: null,
                      }),
                    getProviderWithKey: () =>
                      Effect.succeed({
                        id: "p1",
                        preset: "azure",
                        settings: {},
                        apiKey: Redacted.make("sk-test"),
                        baseUrl: "https://resource.test/openai/v1",
                        enabled: true,
                      }),
                    setModelFormat: (modelId: string, format: string) =>
                      Effect.sync(() => void recorded.push([modelId, format])),
                  }),
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
});
