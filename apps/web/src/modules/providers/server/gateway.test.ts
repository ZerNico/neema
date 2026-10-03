import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { vi } from "vitest";
import { AnalyticsRepo, type UsageEventInput } from "~/modules/analytics/server/repo.ts";
import { runtimeContextMessage } from "~/modules/chat/server/runtime-context.ts";
import { buildHistoryMessages, type PromptDeps } from "~/modules/chat/server/prompt.ts";
import { ResearchCoordinatorTools } from "~/modules/chat/server/research/runner.ts";
import { ModelNotFound } from "~/modules/chat/errors.ts";
import { ProviderRepo } from "./repo.ts";
import {
  AiGateway,
  ProviderContextOverflow,
  ProviderUnreachable,
  anchorLastMessage,
  cacheAnchor,
  isContextOverflow,
} from "./gateway.ts";
import { Catalog } from "@chat/model-client";

const { catalogPricing, inferType } = Catalog;

describe("provider catalog normalization", () => {
  it("preserves input-only pricing for embedding configuration", () => {
    expect(catalogPricing({ prompt: "0.00000002" })).toEqual({ input: 0.02, output: null });
    expect(catalogPricing({ prompt: "0", completion: "0" })).toEqual({ input: 0, output: 0 });
    expect(catalogPricing({ completion: "0.000001" })).toBeNull();
  });

  it("keeps text models and excludes image/audio output models", () => {
    expect(inferType(undefined)).toBe("chat");
    expect(inferType(["text"])).toBe("chat");
    expect(inferType(["image"])).toBeNull();
    expect(inferType(["audio"])).toBeNull();
    // OpenRouter's embedding models: no text output, an "embeddings" modality.
    expect(inferType(["embeddings"])).toBe("embedding");
    expect(inferType(["embedding"])).toBe("embedding");
    // Reranking, speech and video are not registry types either.
    expect(inferType(["rerank"])).toBeNull();
    expect(inferType(["speech"])).toBeNull();
    expect(inferType(["video"])).toBeNull();
  });
});

// A provider that speaks plain OpenAI, not OpenRouter: chunks carry no
// `system_fingerprint` and no `openrouter_metadata`. The non-streaming
// completion schema requires that field, which is why side generations post a
// streaming request like everything else.
const sse = (chunks: ReadonlyArray<Record<string, unknown>>) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "gen-1",
  object: "chat.completion.chunk",
  created: 1_756_000_000,
  model: "vendor/model",
  choices: [{ index: 0, delta }],
  ...extra,
});

const usageChunk = (usage: Record<string, unknown>) => ({
  ...chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  usage,
});

// One stable stub for the whole file: effect memoizes the `Fetch` reference's
// default the first time a client reads it, so swapping the global per test
// would leave every later test talking to the first stub.
const ledger: UsageEventInput[] = [];
const analyticsStub = Layer.succeed(AnalyticsRepo, {
  record: (event: UsageEventInput) =>
    Effect.sync(() => {
      ledger.push(event);
    }),
} as AnalyticsRepo["Service"]);
const GatewayLayer = AiGateway.layer.pipe(Layer.provide(analyticsStub));
const requests: Array<{ url: string; body: unknown }> = [];
let responseBody = "";
let responseStatus = 200;
let responseHeaders: Record<string, string> = {};
let delayedResponse: (() => Promise<Response>) | null = null;
let embeddingContextLength: number | null = null;
let embeddingInputPrice = 0.02;

// GET catalog requests have no body; a per-URL responder lets one test answer
// the two OpenRouter listings differently.
let responseFor: ((url: string) => string | null) | null = null;

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
  const routed = responseFor?.(url);
  if (routed !== null && routed !== undefined)
    return Promise.resolve(
      new Response(routed, { status: 200, headers: { "content-type": "application/json" } }),
    );
  if (delayedResponse) return delayedResponse();
  return Promise.resolve(
    new Response(responseBody, {
      status: responseStatus,
      headers: {
        "content-type": responseStatus === 200 ? "text/event-stream" : "application/json",
        ...responseHeaders,
      },
    }),
  );
});

const stubProvider = (body: string, status = 200, headers: Record<string, string> = {}) => {
  requests.length = 0;
  ledger.length = 0;
  delayedResponse = null;
  responseFor = null;
  embeddingContextLength = null;
  embeddingInputPrice = 0.02;
  responseBody = body;
  responseStatus = status;
  responseHeaders = headers;
  return requests;
};

const repoWith = (
  tools: boolean,
  imageOutput = false,
  kind = "openai-compatible",
  vision = false,
  modelKey = "vendor/model",
  reasoningEffortFormat: "unsupported" | "flat" | "nested" = "unsupported",
) =>
  Layer.succeed(ProviderRepo)(
    ProviderRepo.of(
      // The gateway reaches for nothing else.
      Object.assign({} as ProviderRepo["Service"], {
        getModel: () =>
          Effect.succeed({
            id: "m1",
            providerId: "p1",
            modelKey,
            capabilities: { reasoning: false, tools, vision, files: false, imageOutput },
          }),
        getProviderWithKey: () =>
          Effect.succeed({
            id: "p1",
            apiKey: "sk-test",
            baseUrl: "https://provider.test/v1",
            preset: kind === "openai-compatible" ? "custom" : kind,
            settings:
              reasoningEffortFormat === "unsupported" ? {} : { reasoning: reasoningEffortFormat },
          }),
      }),
    ),
  );
const repoStub = repoWith(true);
// A model that cannot take a `tools` parameter: the gateway polyfills it.
const noToolsRepo = repoWith(false);

const generate = Effect.flatMap(AiGateway, (gateway) =>
  gateway.generateText({ modelId: "m1", prompt: Prompt.make("Summarize this") }),
).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))));

describe("provider prompt ordering", () => {
  it.effect(
    "serializes runtime context after history instead of moving it into system instructions",
    () =>
      Effect.gen(function* () {
        const recorded = stubProvider(
          sse([
            chunk({ content: "Saturday" }),
            usageChunk({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
          ]),
        );
        const clock = runtimeContextMessage(new Date("2026-09-05T12:00:00Z"), "Europe/Berlin");
        yield* Effect.flatMap(AiGateway, (gateway) =>
          gateway.generateText({
            modelId: "m1",
            prompt: Prompt.make([
              { role: "system", content: "Stable policy" },
              { role: "user", content: "Earlier question" },
              { role: "assistant", content: "Earlier answer" },
              { role: "user", content: "What day is it?" },
              clock,
            ]),
          }),
        ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))));
        expect(recorded[0]?.body).toMatchObject({
          messages: [
            { role: "system", content: "Stable policy" },
            { role: "user", content: "Earlier question" },
            { role: "assistant", content: "Earlier answer" },
            { role: "user", content: "What day is it?" },
            { role: "user", content: clock.content },
          ],
        });
      }),
  );
});

describe("prompt cache points", () => {
  const prompt = Prompt.make([
    cacheAnchor({ role: "system", content: "Stable policy" }),
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
    cacheAnchor({ role: "user", content: "Current question" }),
    { role: "user", content: "Per-request data" },
  ]);
  const send = (kind: string, modelKey: string) =>
    Effect.gen(function* () {
      const recorded = stubProvider(
        sse([
          chunk({ content: "ok" }),
          usageChunk({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
        ]),
      );
      yield* Effect.flatMap(AiGateway, (gateway) =>
        Stream.runDrain(gateway.streamChat({ modelId: "m1", prompt })),
      ).pipe(
        Effect.provide(
          GatewayLayer.pipe(Layer.provide(repoWith(true, false, kind, false, modelKey))),
        ),
      );
      return JSON.stringify(recorded[0]?.body);
    });

  it.effect("marks the anchored messages for Claude on OpenRouter, and nothing after them", () =>
    Effect.gen(function* () {
      const body = JSON.parse(yield* send("openrouter", "anthropic/claude-sonnet-5")) as {
        messages: Array<{ content: unknown }>;
      };
      const marked = body.messages.map((message) =>
        JSON.stringify(message).includes("cache_control"),
      );
      expect(marked).toEqual([true, false, false, true, false]);
      expect(body.messages[3]).toEqual({
        role: "user",
        content: [{ type: "text", text: "Current question", cache_control: { type: "ephemeral" } }],
      });
    }),
  );

  it.effect("anchors a completed tool round on its last result", () =>
    Effect.gen(function* () {
      const recorded = stubProvider(
        sse([
          chunk({ content: "ok" }),
          usageChunk({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
        ]),
      );
      const round = Prompt.make([
        { role: "user", content: "Find it" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", id: "a", name: "web_search", params: {} },
            { type: "tool-call", id: "b", name: "web_search", params: {} },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", id: "a", name: "web_search", isFailure: false, result: "one" },
            { type: "tool-result", id: "b", name: "web_search", isFailure: false, result: "two" },
          ],
        },
      ]);
      yield* Effect.flatMap(AiGateway, (gateway) =>
        Stream.runDrain(
          gateway.streamChat({
            modelId: "m1",
            prompt: anchorLastMessage(round),
            cacheKey: "conversation-1",
          }),
        ),
      ).pipe(
        Effect.provide(
          GatewayLayer.pipe(
            Layer.provide(repoWith(true, false, "openrouter", false, "anthropic/claude-sonnet-5")),
          ),
        ),
      );
      const body = recorded[0]?.body as {
        messages: Array<{ role: string; content: unknown }>;
        session_id?: string;
        prompt_cache_key?: string;
      };
      const results = body.messages.filter((message) => message.role === "tool");
      expect(results.map((message) => message.content)).toEqual([
        "one",
        [{ type: "text", text: "two", cache_control: { type: "ephemeral" } }],
      ]);
      expect(body.session_id).toBe("conversation-1");
      expect(body.prompt_cache_key).toBe("conversation-1");
    }),
  );

  it.effect("keeps the cache key from servers that are not OpenRouter", () =>
    Effect.gen(function* () {
      const recorded = stubProvider(
        sse([
          chunk({ content: "ok" }),
          usageChunk({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
        ]),
      );
      yield* Effect.flatMap(AiGateway, (gateway) =>
        Stream.runDrain(gateway.streamChat({ modelId: "m1", prompt, cacheKey: "c" })),
      ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))));
      expect(recorded[0]?.body).not.toHaveProperty("session_id");
      expect(recorded[0]?.body).not.toHaveProperty("prompt_cache_key");
    }),
  );

  for (const [kind, modelKey] of [
    ["openrouter", "openai/gpt-5.6"],
    ["openai-compatible", "anthropic/claude-sonnet-5"],
    ["openai-compatible", "cc/claude-sonnet-5"],
  ] as const)
    it.effect(`sends no cache points to ${modelKey} on ${kind}, which caches by itself`, () =>
      Effect.gen(function* () {
        const body = yield* send(kind, modelKey);
        expect(body).not.toContain("cache_control");
        expect(body).not.toContain("anchor");
      }),
    );
});

describe("reasoning effort requests", () => {
  const send = (kind: string, format: "unsupported" | "flat" | "nested", effort?: "high" | null) =>
    Effect.gen(function* () {
      const recorded = stubProvider(
        sse([usageChunk({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })]),
      );
      yield* Effect.flatMap(AiGateway, (gateway) =>
        Stream.runDrain(
          gateway.streamChat({
            modelId: "m1",
            prompt: Prompt.make("Hello"),
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          }),
        ),
      ).pipe(
        Effect.provide(
          GatewayLayer.pipe(
            Layer.provide(repoWith(true, false, kind, false, "vendor/model", format)),
          ),
        ),
      );
      return recorded[0]?.body;
    });

  it.effect("sends nested effort to OpenRouter regardless of the stored generic format", () =>
    Effect.gen(function* () {
      expect(yield* send("openrouter", "unsupported", "high")).toMatchObject({
        reasoning: { effort: "high" },
      });
    }),
  );
  it.effect("sends flat and nested effort only when explicitly configured", () =>
    Effect.gen(function* () {
      expect(yield* send("openai-compatible", "flat", "high")).toMatchObject({
        reasoning_effort: "high",
      });
      expect(yield* send("openai-compatible", "nested", "high")).toMatchObject({
        reasoning: { effort: "high" },
      });
      const unsupported = yield* send("openai-compatible", "unsupported", "high");
      expect(unsupported).not.toHaveProperty("reasoning");
      expect(unsupported).not.toHaveProperty("reasoning_effort");
    }),
  );
  it.effect("omits effort on null or omitted input and on side generations", () =>
    Effect.gen(function* () {
      for (const effort of [null, undefined]) {
        const body = yield* send("openrouter", "unsupported", effort);
        expect(body).not.toHaveProperty("reasoning");
        expect(body).not.toHaveProperty("reasoning_effort");
      }
      const recorded = stubProvider(
        sse([usageChunk({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })]),
      );
      yield* generate;
      expect(recorded[0]?.body).not.toHaveProperty("reasoning");
      expect(recorded[0]?.body).not.toHaveProperty("reasoning_effort");
    }),
  );
});

describe("side generations", () => {
  it.effect("completes against a provider that omits system_fingerprint", () =>
    Effect.gen(function* () {
      const requests = stubProvider(
        sse([
          chunk({ role: "assistant", content: "" }),
          chunk({ content: "TYPO3 release " }),
          chunk({ content: "changelog" }),
          usageChunk({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }),
        ]),
      );

      const result = yield* generate;

      expect(result.text).toBe("TYPO3 release changelog");
      expect(result.usage.inputTokens.total).toBe(7);
      expect(result.usage.outputTokens.total).toBe(3);
      // Streaming, not the one-shot completion whose schema demands the field.
      expect(requests[0]?.url).toBe("https://provider.test/v1/chat/completions");
      expect(requests[0]?.body).toMatchObject({ stream: true });
    }),
  );

  it.effect("keeps a model's think block out of the generated text", () =>
    Effect.gen(function* () {
      stubProvider(
        sse([
          chunk({ content: "<think>The user wants" }),
          chunk({ content: " a short one.</think>Release notes" }),
          usageChunk({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }),
        ]),
      );

      expect((yield* generate).text).toBe("Release notes");
    }),
  );

  it.effect("bills nothing when the provider never reports usage", () =>
    Effect.gen(function* () {
      stubProvider(sse([chunk({ content: "Release notes" })]));

      const result = yield* generate;

      expect(result.text).toBe("Release notes");
      // What `addFinishUsage` reads as "no usage seen": no ledger row, rather
      // than a failed title or a lost compaction summary.
      expect(result.usage.inputTokens.total).toBeUndefined();
      expect(result.usage.outputTokens.total).toBeUndefined();
    }),
  );
});

const probeRepo = (enabled: boolean) =>
  Layer.succeed(ProviderRepo)(
    ProviderRepo.of(
      // A model that is not saved yet: only the provider is looked up.
      Object.assign({} as ProviderRepo["Service"], {
        getModel: () => Effect.die("the probe must not need a stored model"),
        getProviderWithKey: () =>
          Effect.succeed({
            id: "p1",
            apiKey: "sk-test",
            baseUrl: "https://provider.test/v1",
            preset: "custom",
            settings: {},
            enabled,
          }),
      }),
    ),
  );
const probe = (enabled = true) =>
  Effect.flatMap(AiGateway, (gateway) =>
    gateway.probeChatModel({ providerId: "p1", modelKey: " vendor/new-model " }),
  ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(probeRepo(enabled)))));

describe("chat model probe", () => {
  it.effect("asks an unsaved model for a short reply, without its think block", () =>
    Effect.gen(function* () {
      const sent = stubProvider(
        sse([
          chunk({ content: "<think>Easy.</think>OK" }),
          usageChunk({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }),
        ]),
      );

      expect(yield* probe()).toEqual({ reply: "OK" });
      expect(sent[0]?.url).toBe("https://provider.test/v1/chat/completions");
      expect(sent[0]?.body).toMatchObject({
        model: "vendor/new-model",
        max_tokens: 512,
        stream: true,
      });
      expect(sent[0]?.body).not.toHaveProperty("tools");
    }),
  );

  it.effect("reports a rejected model ID as an unreachable provider", () =>
    Effect.gen(function* () {
      stubProvider(JSON.stringify({ error: { message: "model not found" } }), 404);

      expect(yield* probe().pipe(Effect.flip)).toBeInstanceOf(ProviderUnreachable);
    }),
  );

  it.effect("refuses a disabled provider without a request", () =>
    Effect.gen(function* () {
      const sent = stubProvider(sse([chunk({ content: "OK" })]));

      expect(yield* probe(false).pipe(Effect.flip)).toBeInstanceOf(ModelNotFound);
      expect(sent).toHaveLength(0);
    }),
  );
});

describe("provider failure diagnostics", () => {
  it("classifies only string error messages, not arbitrary payload fields", () => {
    expect(isContextOverflow({ message: "maximum context length exceeded" })).toBe(true);
    expect(isContextOverflow(new Error("prompt is too long"))).toBe(true);
    expect(isContextOverflow("context_length_exceeded")).toBe(true);
    expect(isContextOverflow({ message: { detail: "context window" } })).toBe(false);
    expect(isContextOverflow({ message: 400, metadata: "context window" })).toBe(false);
    expect(isContextOverflow(null)).toBe(false);
  });

  for (const mode of ["chat", "side generation"] as const) {
    it.effect(`classifies a plain-object SSE context overflow in ${mode}`, () =>
      Effect.gen(function* () {
        const message = "This model's maximum context length is 8192 tokens";
        stubProvider(sse([chunk({}, { error: { code: 400, message } })]));
        const request =
          mode === "chat"
            ? Effect.flatMap(AiGateway, (gateway) =>
                Stream.runDrain(gateway.streamChat({ modelId: "m1", prompt: Prompt.make("Test") })),
              ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))))
            : generate;
        const error = yield* request.pipe(Effect.flip);
        expect(error).toBeInstanceOf(ProviderContextOverflow);
        expect(error).toMatchObject({ providerId: "p1", message });
        expect(requests).toHaveLength(1);
      }),
    );
  }

  it.effect("preserves the rejection kind and HTTP status without copying provider payloads", () =>
    Effect.gen(function* () {
      stubProvider(
        JSON.stringify({
          error: { message: "PRIVATE request body sk-secret", type: "invalid_request_error" },
        }),
        400,
      );
      const error = yield* Effect.flatMap(AiGateway, (gateway) =>
        Stream.runDrain(gateway.streamChat({ modelId: "m1", prompt: Prompt.make("Test") })),
      ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))), Effect.flip);
      expect(error).toBeInstanceOf(ProviderUnreachable);
      if (error instanceof ProviderUnreachable) {
        expect(error.diagnostic).toEqual({ kind: "InvalidRequestError", status: 400 });
        expect(JSON.stringify(error.diagnostic)).not.toMatch(
          /PRIVATE|sk-secret|authorization|headers/,
        );
      }
    }),
  );
  it.effect("retains an SSE error code without treating it as an HTTP rejection", () =>
    Effect.gen(function* () {
      stubProvider(
        sse([
          chunk(
            {},
            {
              error: { code: 400, message: "PRIVATE request body sk-secret" },
            },
          ),
        ]),
      );
      const error = yield* Effect.flatMap(AiGateway, (gateway) =>
        Stream.runDrain(gateway.streamChat({ modelId: "m1", prompt: Prompt.make("Test") })),
      ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))), Effect.flip);
      expect(error).toBeInstanceOf(ProviderUnreachable);
      if (error instanceof ProviderUnreachable) {
        expect(error.message).toBe("PRIVATE request body sk-secret");
        expect(error.diagnostic).toEqual({ kind: "ProviderStreamError", code: 400 });
        expect(JSON.stringify(error.diagnostic)).not.toMatch(/PRIVATE|sk-secret/);
      }
    }),
  );
  it.effect("distinguishes invalid streamed output from HTTP request rejection", () =>
    Effect.gen(function* () {
      stubProvider(sse([{ invalid: "PRIVATE" }]));
      const error = yield* Effect.flatMap(AiGateway, (gateway) =>
        Stream.runDrain(gateway.streamChat({ modelId: "m1", prompt: Prompt.make("Test") })),
      ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))), Effect.flip);
      expect(error).toBeInstanceOf(ProviderUnreachable);
      if (error instanceof ProviderUnreachable)
        expect(error.diagnostic).toEqual({ kind: "InvalidOutputError" });
    }),
  );
});

describe("sensitive input diagnostics for text output", () => {
  const secret = "PRIVATE-replay-signature";
  const details = [{ type: "reasoning.encrypted" as const, data: secret, id: "signed" }];
  const unit = {
    v: 1 as const,
    id: "unit-1",
    identity: {
      provider: "p1",
      baseUrl: "https://provider.test/v1",
      format: "chat-completions" as const,
      model: "vendor/model",
    },
    format: "chat-completions" as const,
    reasoningDetails: details,
  };
  // The model still reads images, but its output capability has been disabled.
  const layer = GatewayLayer.pipe(Layer.provide(repoWith(true, false, "openrouter", true)));
  const request = (mode: "chat" | "side", prompt: Prompt.Prompt) =>
    Effect.flatMap(AiGateway, (gateway) =>
      mode === "chat"
        ? Stream.runDrain(gateway.streamChat({ modelId: "m1", prompt, imageOutput: false }))
        : gateway.generateText({ modelId: "m1", prompt }).pipe(Effect.asVoid),
    ).pipe(Effect.provide(layer));

  for (const mode of ["chat", "side"] as const) {
    for (const failure of ["sse", "http", "context"] as const) {
      it.effect(`sanitizes compatible private history in ${mode} on ${failure} failure`, () =>
        Effect.gen(function* () {
          const raw = `${failure === "context" ? "maximum context length exceeded" : "invalid signature"}: ${secret}`;
          stubProvider(
            failure === "http"
              ? JSON.stringify({ error: { message: raw, type: "invalid_request_error" } })
              : sse([chunk({}, { error: { code: 400, message: raw } })]),
            failure === "http" ? 400 : 200,
          );
          const history = yield* buildHistoryMessages(
            Object.assign({} as PromptDeps, {
              attachments: { listWithBlobsForMessages: () => Effect.succeed([]) },
            }),
            {
              messages: [
                {
                  id: "answer",
                  role: "assistant",
                  content: "Original[^1]",
                  completedAt: new Date("2026-09-08T12:00:00Z"),
                  providerReplay: {
                    v: 1,
                    turns: [{ turnIndex: 0, startOffset: 0, endOffset: 12, unit }],
                  },
                },
              ],
              modelIdentity: { providerId: "p1", modelKey: "vendor/model" },
              modelSupportsFiles: false,
              modelSupportsVision: true,
              expandAssistantTurns: true,
            },
          );
          const error = yield* request(
            mode,
            Prompt.make([...history, { role: "user", content: "Explain" }]),
          ).pipe(Effect.flip);
          expect(JSON.stringify(error)).not.toContain(secret);
          expect(String(error)).not.toContain(secret);
          if (failure === "context") {
            expect(error).toBeInstanceOf(ProviderContextOverflow);
          } else {
            expect(error).toBeInstanceOf(ProviderUnreachable);
            expect(error).toMatchObject({
              message: "The provider could not complete this request.",
              diagnostic:
                failure === "http"
                  ? { kind: "InvalidRequestError", status: 400 }
                  : { kind: "ProviderStreamError", code: 400 },
            });
          }
          // Actual adapter encoding preserves the protected assistant text and
          // private metadata, with timestamps outside that assistant message.
          expect(requests[0]?.body).toMatchObject({
            modalities: ["text"],
            messages: [
              {
                role: "user",
                content: expect.stringContaining("Completed: 2026-09-08T12:00:00.000Z"),
              },
              { role: "assistant", content: "Original[^1]", reasoning_details: details },
              { role: "user", content: "Explain" },
            ],
          });
        }),
      );
    }
    for (const source of ["reasoning", "tool-call", "image"] as const) {
      it.effect(`sanitizes ${source} part input diagnostics in ${mode}`, () =>
        Effect.gen(function* () {
          stubProvider(sse([chunk({}, { error: { code: 400, message: secret } })]));
          const part: Prompt.AssistantMessagePartEncoded =
            source === "image"
              ? { type: "file", mediaType: "image/png", data: "cHJpdmF0ZQ==" }
              : source === "reasoning"
                ? {
                    type: "reasoning",
                    text: "",
                    options: { modelClient: { replay: unit } },
                  }
                : {
                    type: "tool-call",
                    id: "call",
                    name: "inspect",
                    params: {},
                    options: { modelClient: { replay: unit } },
                  };
          const error = yield* request(
            mode,
            Prompt.make([
              { role: "assistant", content: [part] },
              ...(source === "tool-call"
                ? [
                    {
                      role: "tool" as const,
                      content: [
                        {
                          type: "tool-result" as const,
                          id: "call",
                          name: "inspect",
                          isFailure: false,
                          result: "ok",
                        },
                      ],
                    },
                  ]
                : []),
              { role: "user", content: "Explain" },
            ]),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({
            message: "The provider could not complete this request.",
            diagnostic: { kind: "ProviderStreamError", code: 400 },
          });
          expect(JSON.stringify(error)).not.toContain(secret);
        }),
      );
    }
    it.effect(`keeps ordinary text diagnostics with empty replay metadata in ${mode}`, () =>
      Effect.gen(function* () {
        stubProvider(
          sse([chunk({}, { error: { code: 400, message: "Unsupported request parameter" } })]),
        );
        const error = yield* request(
          mode,
          Prompt.make([
            {
              role: "assistant",
              content: "Answer",
              options: { modelClient: { replay: { ...unit, reasoningDetails: [] } } },
            },
            { role: "user", content: "Explain" },
          ]),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ message: "Unsupported request parameter" });
      }),
    );
  }
});

describe("research streaming request ceilings", () => {
  it.effect("sends object-root coordinator tool schemas through the real provider adapter", () =>
    Effect.gen(function* () {
      const tasks = [{ title: "Evidence", assignment: "Investigate primary sources." }];
      const dispatch = vi.fn();
      const finish = vi.fn();
      const recorded = stubProvider(
        sse([
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "dispatch-1",
                type: "function",
                function: { name: "dispatch_research", arguments: JSON.stringify({ tasks }) },
              },
              {
                index: 1,
                id: "finish-1",
                type: "function",
                function: { name: "finish_research", arguments: "{}" },
              },
            ],
          }),
          usageChunk({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
        ]),
      );
      const toolkit = yield* ResearchCoordinatorTools.pipe(
        Effect.provide(
          ResearchCoordinatorTools.toLayer({
            dispatch_research: (params) =>
              Effect.sync(() => {
                dispatch(params);
                return { accepted: params.tasks.length };
              }),
            finish_research: (params) =>
              Effect.sync(() => {
                finish(params);
                return { ok: true };
              }),
          }),
        ),
      );
      yield* Effect.flatMap(AiGateway, (gateway) =>
        Stream.runDrain(
          gateway.streamChat({ modelId: "m1", prompt: Prompt.make("Coordinate"), toolkit }),
        ),
      ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))));
      expect(dispatch).toHaveBeenCalledWith({ tasks });
      expect(finish).toHaveBeenCalledWith({});
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.body).toMatchObject({
        tools: [
          {
            type: "function",
            function: {
              name: "dispatch_research",
              parameters: { type: "object", required: ["tasks"] },
            },
          },
          {
            type: "function",
            function: {
              name: "finish_research",
              parameters: { type: "object", additionalProperties: false },
            },
          },
        ],
      });
    }),
  );

  it.effect(
    "passes optional maxOutputTokens through streaming without changing ordinary defaults",
    () =>
      Effect.gen(function* () {
        const recorded = stubProvider(
          sse([
            chunk({ content: "bounded" }),
            usageChunk({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }),
          ]),
        );
        yield* Effect.flatMap(AiGateway, (gateway) =>
          Stream.runDrain(
            gateway.streamChat({
              modelId: "m1",
              prompt: Prompt.make("Investigate"),
              maxOutputTokens: 4096,
            }),
          ),
        ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))));
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.body).toMatchObject({ stream: true, max_tokens: 4096 });
        recorded.length = 0;
        yield* Effect.flatMap(AiGateway, (gateway) =>
          Stream.runDrain(gateway.streamChat({ modelId: "m1", prompt: Prompt.make("Hello") })),
        ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub))));
        expect(recorded[0]?.body).not.toHaveProperty("max_tokens");
      }),
  );
});

const messagesOf = (body: unknown) =>
  (body as { messages: Array<{ role: string; content: unknown; tool_calls?: unknown }> }).messages;

describe("prompt-based tool calling for models without native support", () => {
  const webSearch = Tool.make("web_search", {
    description: "Search the web",
    parameters: Schema.Struct({ queries: Schema.Array(Schema.String) }),
    success: Schema.Struct({ hits: Schema.Number }),
  });
  const toolkit = Toolkit.make(webSearch).pipe(
    Effect.provide(
      Toolkit.make(webSearch).toLayer({ web_search: () => Effect.succeed({ hits: 2 }) }),
    ),
  );
  const hermesCall = `<tool_call>\n${JSON.stringify({ name: "web_search", arguments: { queries: ["effect 4"] } })}\n</tool_call>`;

  it.effect("runs a full tool round trip without tools or tool roles on the wire", () =>
    Effect.gen(function* () {
      const recorded = stubProvider(
        sse([
          chunk({ role: "assistant", content: "" }),
          chunk({ content: "Let me check. " }),
          chunk({ content: hermesCall.slice(0, 20) }),
          chunk({ content: hermesCall.slice(20) }),
          usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
        ]),
      );
      const gateway = yield* AiGateway;
      const prompt = Prompt.make([
        { role: "system", content: "Stable policy" },
        { role: "user", content: "What is new in Effect 4?" },
      ]);
      const parts = yield* Stream.runCollect(
        gateway.streamChat({ modelId: "m1", prompt, toolkit: yield* toolkit }),
      ).pipe(Effect.map((chunks) => Array.from(chunks)));

      // Request: no native tool parameters, the Hermes block appended to the
      // app's own system prompt.
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.body).not.toHaveProperty("tools");
      expect(recorded[0]?.body).not.toHaveProperty("tool_choice");
      const system = messagesOf(recorded[0]?.body)[0]!;
      expect(system.role).toBe("system");
      const systemText = JSON.stringify(system.content);
      expect(systemText.indexOf("Stable policy")).toBeLessThan(systemText.indexOf("<tools>"));
      expect(systemText).toContain('\\"name\\":\\"web_search\\"');
      expect(systemText).toContain("<tool_call>");

      // Response: the block became a tool call the library resolved.
      const call = parts.find((part) => part.type === "tool-call");
      expect(call).toMatchObject({ name: "web_search", params: { queries: ["effect 4"] } });
      const result = parts.find((part) => part.type === "tool-result");
      expect(result).toMatchObject({ name: "web_search", result: { hits: 2 } });
      expect(parts.find((part) => part.type === "finish")).toMatchObject({
        reason: "tool-calls",
      });
      const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));
      expect(text.join("")).toBe("Let me check. ");

      // Continuation: the loop in streaming.ts feeds the parts back verbatim.
      // The wire then carries the call and its result as Hermes text.
      stubProvider(
        sse([
          chunk({ content: "Effect 4 has a new Layer API." }),
          usageChunk({ prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }),
        ]),
      );
      const next = yield* Stream.runCollect(
        gateway.streamChat({
          modelId: "m1",
          prompt: Prompt.concat(prompt, Prompt.fromResponseParts(parts)),
          toolkit: yield* toolkit,
        }),
      ).pipe(Effect.map((chunks) => Array.from(chunks)));
      expect(next.find((part) => part.type === "finish")).toMatchObject({ reason: "stop" });
      const messages = messagesOf(recorded[0]?.body);
      expect(messages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "user",
      ]);
      expect(messages.some((message) => message.tool_calls !== undefined)).toBe(false);
      expect(messages[2]?.content).toContain("<tool_call>");
      expect(messages[2]?.content).toContain('"name":"web_search"');
      expect(JSON.stringify(messages[3]?.content)).toContain("<tool_response>");
      expect(JSON.stringify(messages[3]?.content)).toContain('\\"hits\\":2');
    }).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(noToolsRepo)))),
  );

  it.effect("leaves tool-free generations untouched", () =>
    Effect.gen(function* () {
      const recorded = stubProvider(
        sse([
          chunk({ content: "Title" }),
          usageChunk({ prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 }),
        ]),
      );
      const result = yield* Effect.flatMap(AiGateway, (gateway) =>
        gateway.generateText({ modelId: "m1", prompt: Prompt.make("Name this chat") }),
      );
      expect(result.text).toBe("Title");
      expect(JSON.stringify(recorded[0]?.body)).not.toContain("<tools>");
    }).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(noToolsRepo)))),
  );

  it.effect("keeps native tool parameters for a model that supports them", () =>
    Effect.gen(function* () {
      const recorded = stubProvider(
        sse([
          chunk({ content: "No tools needed." }),
          usageChunk({ prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 }),
        ]),
      );
      const gateway = yield* AiGateway;
      yield* Stream.runDrain(
        gateway.streamChat({ modelId: "m1", prompt: Prompt.make("Hi"), toolkit: yield* toolkit }),
      );
      expect(recorded[0]?.body).toMatchObject({
        tools: [{ type: "function", function: { name: "web_search" } }],
      });
      expect(JSON.stringify(recorded[0]?.body)).not.toContain("<tools>");
    }).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoStub)))),
  );
});

const embeddingRepo = Layer.succeed(
  ProviderRepo,
  ProviderRepo.of(
    Object.assign({} as ProviderRepo["Service"], {
      getModel: () =>
        Effect.succeed({
          id: "embedding",
          providerId: "p1",
          modelKey: "vendor/embed",
          type: "embedding",
          enabled: true,
          access: "public",
          embeddingDimensions: 3,
          displayName: "Embedding model",
          contextLength: embeddingContextLength,
          pricing: { input: embeddingInputPrice, output: null },
        }),
      getProviderWithKey: () =>
        Effect.succeed({
          id: "p1",
          enabled: true,
          preset: "custom",
          settings: {},
          apiKey: Redacted.make("fake-key"),
          baseUrl: "https://provider.test/v1",
        }),
    }),
  ),
);
const embed = Effect.flatMap(AiGateway, (gateway) =>
  gateway.embed({
    attribution: { userId: "requester", kind: "embedding_query" },
    modelId: "embedding",
    inputs: ["one", "two"],
    expectedDimensions: 3,
  }),
).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(embeddingRepo))));

describe("bounded embedding gateway", () => {
  it.effect("orders indexed results and verifies the approved width without requesting it", () =>
    Effect.gen(function* () {
      stubProvider(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
          usage: { prompt_tokens: 5 },
        }),
      );
      const result = yield* embed;
      expect(result).toEqual({
        embeddings: [
          [1, 0, 0],
          [0, 1, 0],
        ],
        dimensions: 3,
        inputTokens: 5,
      });
      expect(ledger).toEqual([
        {
          userId: "requester",
          kind: "embedding_query",
          modelId: "embedding",
          modelName: "Embedding model",
          status: "complete",
          inputTokens: 5,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          usageComplete: true,
          cost: expect.closeTo(0.0000001, 15),
          costSource: "pricing",
        },
      ]);
      expect(requests[0]).toEqual({
        url: "https://provider.test/v1/embeddings",
        body: { model: "vendor/embed", input: ["one", "two"] },
      });
    }),
  );
  it.each([
    [{ index: 0, embedding: [1, 0, 0] }],
    [
      { index: 0, embedding: [1, 0, 0] },
      { index: 0, embedding: [0, 1, 0] },
    ],
    [{ index: 0, embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }],
    [
      { index: 0, embedding: [1, 0] },
      { index: 1, embedding: [0, 1] },
    ],
    [
      { index: 0, embedding: [0, 0, 0] },
      { index: 1, embedding: [0, 1, 0] },
    ],
  ])("rejects incomplete or malformed vectors", async (...data) => {
    stubProvider(JSON.stringify({ data }));
    const error = await Effect.runPromise(Effect.flip(embed));
    expect(error._tag).toBe("ProviderUnreachable");
  });
  it.effect("does not copy provider payloads into embedding errors", () =>
    Effect.gen(function* () {
      stubProvider(JSON.stringify({ error: "private input fake-secret" }), 400);
      const error = yield* Effect.flip(embed);
      expect(error).toMatchObject({
        message: "the embedding provider answered 400",
        diagnostic: { kind: "InvalidRequestError", status: 400 },
      });
      expect(JSON.stringify(error)).not.toContain("private input");
    }),
  );
  it.effect("reports a rate limit with the wait the provider asked for", () =>
    Effect.gen(function* () {
      stubProvider(JSON.stringify({ error: "slow down" }), 429, { "retry-after": "12" });
      const error = yield* Effect.flip(embed);
      expect(error).toMatchObject({
        diagnostic: { kind: "RateLimitError", status: 429, retryAfterMs: 12_000 },
      });
    }),
  );
  it.effect("rejects a changed approved connection before sending any input", () =>
    Effect.gen(function* () {
      stubProvider("{}");
      const error = yield* Effect.flatMap(AiGateway, (gateway) =>
        Effect.flip(
          gateway.embed({
            attribution: { userId: "requester", kind: "embedding_query" },
            modelId: "embedding",
            inputs: ["private input"],
            expectedDimensions: 3,
            expectedConnection: {
              providerId: "old",
              baseUrl: "https://old.test",
              modelKey: "vendor/embed",
              modelDimensions: 3,
              preprocessingRevision: 1,
            },
          }),
        ),
      ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(embeddingRepo))));
      expect(error._tag).toBe("ProviderUnreachable");
      expect(requests).toEqual([]);
      expect(ledger).toEqual([]);
    }),
  );
});

describe("embedding attempt accounting", () => {
  const data = [
    { index: 0, embedding: [1, 0, 0] },
    { index: 1, embedding: [0, 1, 0] },
  ];

  it.each([undefined, -1, 1.5, 2_147_483_648, "5"])(
    "keeps absent or invalid usage unknown (%s)",
    async (tokens) => {
      stubProvider(JSON.stringify({ data, usage: { prompt_tokens: tokens } }));
      const result = await Effect.runPromise(embed);
      expect(result.inputTokens).toBeNull();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        status: "complete",
        inputTokens: 0,
        usageComplete: false,
        cost: null,
        costSource: null,
      });
    },
  );

  it.effect("distinguishes known zero from unknown and retains usage on invalid vectors", () =>
    Effect.gen(function* () {
      stubProvider(JSON.stringify({ data, usage: { prompt_tokens: 0 } }));
      yield* embed;
      expect(ledger[0]).toMatchObject({ usageComplete: true, cost: 0, costSource: "pricing" });
      stubProvider(JSON.stringify({ data: [{ index: 0 }], usage: { prompt_tokens: 17 } }));
      yield* Effect.flip(embed);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ status: "error", inputTokens: 17, usageComplete: true });
    }),
  );

  it.effect("counts each failed HTTP retry without storing provider payloads", () =>
    Effect.gen(function* () {
      stubProvider("private query fake-key", 503);
      yield* Effect.flip(embed);
      yield* Effect.flip(embed);
      expect(requests).toHaveLength(2);
      expect(ledger).toHaveLength(2);
      for (const event of ledger)
        expect(event).toMatchObject({ status: "error", usageComplete: false, cost: null });
      expect(JSON.stringify(ledger)).not.toMatch(/private query|fake-key|vendor\/embed/);
    }),
  );

  it.effect("does not count empty batches or rejected input as requests", () =>
    Effect.gen(function* () {
      stubProvider("{}");
      const gateway = yield* AiGateway;
      const base = {
        modelId: "embedding",
        attribution: { userId: "owner", kind: "embedding_document" as const },
      };
      yield* gateway.embed({ ...base, inputs: [] });
      yield* Effect.flip(gateway.embed({ ...base, inputs: ["x".repeat(16_001)] }));
      expect(requests).toEqual([]);
      expect(ledger).toEqual([]);
    }).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(embeddingRepo)))),
  );

  it.effect(
    "bounds individual inputs by the model context without billing preflight failures",
    () =>
      Effect.gen(function* () {
        stubProvider(
          JSON.stringify({
            data: [{ index: 0, embedding: [1, 0, 0] }],
            usage: { prompt_tokens: 2 },
          }),
        );
        embeddingContextLength = 24;
        const gateway = yield* AiGateway;
        const base = {
          modelId: "embedding",
          attribution: { userId: "owner", kind: "embedding_document" as const },
        };
        for (const text of ["x".repeat(9), "漢字語"]) {
          const error = yield* Effect.flip(gateway.embed({ ...base, inputs: [text] }));
          expect(error).toMatchObject({
            _tag: "ProviderUnreachable",
            diagnostic: { kind: "InvalidRequestError" },
          });
        }
        expect(requests).toEqual([]);
        expect(ledger).toEqual([]);
        yield* gateway.embed({ ...base, inputs: ["x".repeat(8)] });
        expect(requests).toHaveLength(1);
        expect(ledger).toHaveLength(1);
      }).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(embeddingRepo)))),
  );

  it.effect("keeps overflowing price calculations unknown rather than persisting infinity", () =>
    Effect.gen(function* () {
      stubProvider(
        JSON.stringify({
          data: [{ index: 0, embedding: [1, 0, 0] }],
          usage: { prompt_tokens: 100 },
        }),
      );
      embeddingInputPrice = Number.MAX_VALUE;
      yield* Effect.flatMap(AiGateway, (gateway) =>
        gateway.embed({
          modelId: "embedding",
          inputs: ["one"],
          attribution: { userId: "owner", kind: "embedding_document" },
        }),
      );
      expect(ledger[0]).toMatchObject({
        usageComplete: true,
        inputTokens: 100,
        cost: null,
        costSource: null,
      });
    }).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(embeddingRepo)))),
  );

  it.effect("rechecks dispatch authorization after waiting for a shared permit", () =>
    Effect.gen(function* () {
      stubProvider("{}");
      const dispatched = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      delayedResponse = () => {
        if (requests.length === 2) Effect.runSync(Deferred.succeed(dispatched, undefined));
        return Effect.runPromise(Deferred.await(release)).then(
          () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] })),
        );
      };
      const gateway = yield* AiGateway;
      const base = {
        modelId: "embedding",
        inputs: ["one"],
        attribution: { userId: "owner", kind: "embedding_document" as const },
      };
      const first = yield* gateway.embed(base).pipe(Effect.forkScoped);
      const second = yield* gateway.embed(base).pipe(Effect.forkScoped);
      yield* Deferred.await(dispatched);
      let allowed = true;
      let checks = 0;
      const waiting = yield* gateway
        .embed({
          ...base,
          beforeDispatch: () =>
            Effect.suspend(() => {
              checks++;
              return allowed
                ? Effect.void
                : Effect.fail(
                    new ProviderUnreachable({ providerId: "p1", message: "selection revoked" }),
                  );
            }),
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(checks).toBe(0);
      allowed = false;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect((yield* Effect.flip(Fiber.join(waiting))).message).toBe("selection revoked");
      expect(checks).toBe(1);
      expect(requests).toHaveLength(2);
      expect(ledger).toHaveLength(2);
    }).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(embeddingRepo))), Effect.scoped),
  );

  it.effect("shares permits and records cancellation only after request dispatch", () =>
    Effect.gen(function* () {
      stubProvider("{}");
      const dispatched = yield* Deferred.make<void>();
      delayedResponse = () => {
        if (requests.length === 2) Effect.runSync(Deferred.succeed(dispatched, undefined));
        return new Promise<Response>(() => {});
      };
      const gateway = yield* AiGateway;
      const request = (kind: "embedding_document" | "embedding_query") =>
        gateway.embed({
          modelId: "embedding",
          inputs: ["one", "two"],
          attribution: { userId: kind === "embedding_document" ? "owner" : "requester", kind },
        });
      const document = yield* request("embedding_document").pipe(Effect.forkScoped);
      const query = yield* request("embedding_query").pipe(Effect.forkScoped);
      yield* Deferred.await(dispatched);
      const waiting = yield* request("embedding_query").pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiting);
      expect(requests).toHaveLength(2);
      expect(ledger).toEqual([]);
      yield* Fiber.interrupt(document);
      yield* Fiber.interrupt(query);
      expect(ledger).toHaveLength(2);
      expect(ledger.map((event) => [event.userId, event.kind])).toEqual([
        ["owner", "embedding_document"],
        ["requester", "embedding_query"],
      ]);
      for (const event of ledger)
        expect(event).toMatchObject({ status: "aborted", usageComplete: false, cost: null });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          delayedResponse = null;
        }),
      ),
      Effect.provide(GatewayLayer.pipe(Layer.provide(embeddingRepo))),
      Effect.scoped,
    ),
  );
});

const catalogEntry = (id: string, outputModalities: string[]) => ({
  id,
  name: id,
  context_length: 8192,
  architecture: { input_modalities: ["text"], output_modalities: outputModalities },
});

describe("provider catalog", () => {
  it.effect("merges OpenRouter's text and embedding listings, typing embedding models", () =>
    Effect.gen(function* () {
      stubProvider("");
      responseFor = (url) =>
        url.includes("output_modalities=embeddings")
          ? JSON.stringify({
              data: [
                catalogEntry("qwen/qwen3-embedding-8b", ["embeddings"]),
                // Also present in the default listing: must not appear twice.
                catalogEntry("vendor/model", ["text"]),
              ],
            })
          : JSON.stringify({
              data: [
                {
                  ...catalogEntry("vendor/model", ["text"]),
                  reasoning: { supported_efforts: ["high", "nonsense", "low", "high"] },
                },
                catalogEntry("vendor/painter", ["image"]),
              ],
            });
      const repo = Layer.succeed(ProviderRepo)(
        ProviderRepo.of(
          Object.assign({} as ProviderRepo["Service"], {
            getProviderWithKey: () =>
              Effect.succeed({
                id: "p1",
                preset: "openrouter",
                settings: {},
                apiKey: Redacted.make("sk-test"),
                baseUrl: "https://provider.test/v1/",
              }),
          }),
        ),
      );
      const catalog = yield* Effect.flatMap(AiGateway, (gateway) =>
        gateway.fetchCatalog("p1"),
      ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repo))));
      expect(requests.map((request) => request.url).sort()).toEqual([
        "https://provider.test/v1/models",
        "https://provider.test/v1/models?output_modalities=embeddings",
      ]);
      expect(catalog.map((model) => [model.id, model.type])).toEqual([
        ["vendor/model", "chat"],
        ["qwen/qwen3-embedding-8b", "embedding"],
      ]);
      expect(catalog[0]?.capabilities).toMatchObject({
        reasoning: true,
        reasoningEfforts: ["low", "high"],
      });
      expect(catalog[1]?.capabilities.reasoningEfforts).toBeUndefined();
    }),
  );

  it.effect("asks a plain OpenAI-compatible endpoint once and keeps its embedding entries", () =>
    Effect.gen(function* () {
      stubProvider("");
      responseFor = () =>
        JSON.stringify({
          data: [
            { ...catalogEntry("gpt", ["text"]), reasoning: { supported_efforts: ["low", "high"] } },
            catalogEntry("text-embedding-3-small", ["embeddings"]),
            // No architecture at all: the admin sets the type by hand.
            { id: "mystery", name: "mystery" },
          ],
        });
      const repo = Layer.succeed(ProviderRepo)(
        ProviderRepo.of(
          Object.assign({} as ProviderRepo["Service"], {
            getProviderWithKey: () =>
              Effect.succeed({
                id: "p2",
                preset: "custom",
                settings: {},
                apiKey: Redacted.make("sk-test"),
                baseUrl: "https://compat.test/v1",
              }),
          }),
        ),
      );
      const catalog = yield* Effect.flatMap(AiGateway, (gateway) =>
        gateway.fetchCatalog("p2"),
      ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repo))));
      expect(requests.map((request) => request.url)).toEqual(["https://compat.test/v1/models"]);
      expect(catalog.map((model) => [model.id, model.type])).toEqual([
        ["gpt", "chat"],
        ["text-embedding-3-small", "embedding"],
        ["mystery", "chat"],
      ]);
      expect(catalog[0]?.capabilities.reasoningEfforts).toBeUndefined();
    }),
  );
});

describe("per-call image output policy", () => {
  for (const [kind, capable, requested, modalities] of [
    ["openai-compatible", false, false, undefined],
    ["openai-compatible", false, true, undefined],
    // Only a preset that asks for image output per call (OpenRouter) can get it.
    ["openai-compatible", true, true, undefined],
    ["openrouter", true, false, ["text"]],
    ["openrouter", true, true, ["text", "image"]],
  ] as const) {
    it.effect(`${kind} capable=${capable} requested=${requested}`, () =>
      Effect.gen(function* () {
        const recorded = stubProvider(
          sse([
            chunk({ content: "<think>Internal</think>Visible" }),
            usageChunk({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
          ]),
        );
        const parts = yield* Effect.flatMap(AiGateway, (gateway) =>
          Stream.runCollect(
            gateway.streamChat({
              modelId: "m1",
              prompt: Prompt.make("Draw"),
              imageOutput: requested,
            }),
          ),
        ).pipe(Effect.provide(GatewayLayer.pipe(Layer.provide(repoWith(true, capable, kind)))));
        if (modalities) expect(recorded[0]?.body).toMatchObject({ modalities });
        else expect(recorded[0]?.body).not.toHaveProperty("modalities");
        // Inline images and text interleave, so <think> splitting stays off for image output.
        expect(parts.some((part) => part.type === "reasoning-delta")).toBe(
          !(modalities as ReadonlyArray<string> | undefined)?.includes("image"),
        );
      }),
    );
  }
});

it.effect("does not expose raw invalid image stream data in provider errors", () =>
  Effect.gen(function* () {
    stubProvider(sse([{ invalid: "data:image/png;base64,private-payload" }]));
    const error = yield* Effect.flatMap(AiGateway, (gateway) =>
      Stream.runDrain(
        gateway.streamChat({ modelId: "m1", prompt: Prompt.make("Draw"), imageOutput: true }),
      ),
    ).pipe(
      Effect.provide(GatewayLayer.pipe(Layer.provide(repoWith(true, true, "openrouter")))),
      Effect.flip,
    );
    expect(error).toMatchObject({
      message: "The image provider could not complete this request.",
      diagnostic: { kind: "InvalidOutputError" },
    });
    expect(JSON.stringify(error)).not.toContain("private-payload");
  }),
);

describe("terminal provider responses through the pinned adapter", () => {
  for (const native of [true, false]) {
    for (const reason of ["stop", "content_filter", "error"] as const) {
      it.effect(`preserves refusal text and ${reason} usage with native=${native}`, () =>
        Effect.gen(function* () {
          stubProvider(
            sse([
              chunk({ content: null, refusal: "I cannot " }),
              chunk({ content: "", refusal: "provide that image." }),
              {
                ...chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: reason }] }),
                usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.04 },
              },
            ]),
          );
          const parts = yield* Effect.flatMap(AiGateway, (gateway) =>
            Stream.runCollect(
              gateway.streamChat({ modelId: "m1", prompt: Prompt.make("Draw"), imageOutput: true }),
            ),
          ).pipe(
            Effect.provide(GatewayLayer.pipe(Layer.provide(repoWith(native, true, "openrouter")))),
          );
          expect(
            parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join(""),
          ).toBe("I cannot provide that image.");
          expect(parts.find((part) => part.type === "finish")).toMatchObject({
            reason: reason === "content_filter" ? "content-filter" : reason,
            usage: { inputTokens: { total: 12 }, outputTokens: { total: 4 } },
            metadata: { modelClient: { cost: 0.04 } },
          });
        }),
      );
    }
  }
});

describe("deferred tools", () => {
  const webSearch = Tool.make("web_search", {
    description: "Search the web",
    parameters: Schema.Struct({ queries: Schema.optionalKey(Schema.Array(Schema.String)) }),
    success: Schema.Struct({ hits: Schema.Number }),
  });
  const editDeck = Tool.make("edit_deck", {
    description: "Edit a deck",
    parameters: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
    success: Schema.Struct({ edited: Schema.Boolean }),
  });
  const toolkit = Toolkit.make(webSearch, editDeck).pipe(
    Effect.provide(
      Toolkit.make(webSearch, editDeck).toLayer({
        web_search: () => Effect.succeed({ hits: 2 }),
        edit_deck: () => Effect.succeed({ edited: true }),
      }),
    ),
  );
  const run = (repo: Layer.Layer<ProviderRepo>) =>
    Effect.flatMap(AiGateway, (gateway) =>
      Effect.flatMap(toolkit, (resolved) =>
        Stream.runCollect(
          gateway.streamChat({
            modelId: "m1",
            prompt: Prompt.make("Make the deck"),
            toolkit: resolved,
            toolChoice: { oneOf: ["web_search"] },
          }),
        ),
      ),
    ).pipe(
      Effect.map((chunks) => Array.from(chunks)),
      Effect.provide(GatewayLayer.pipe(Layer.provide(repo))),
    );

  it.effect("are not advertised natively, yet a call to one still runs", () =>
    Effect.gen(function* () {
      const recorded = stubProvider(
        sse([
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "c1",
                type: "function",
                function: { name: "edit_deck", arguments: JSON.stringify({ title: "Q3" }) },
              },
            ],
          }),
          usageChunk({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
        ]),
      );
      const parts = yield* run(repoStub);
      const body = recorded[0]?.body as { tools: Array<{ function: { name: string } }> };
      expect(body.tools.map((tool) => tool.function.name)).toEqual(["web_search"]);
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        name: "edit_deck",
        result: { edited: true },
      });
    }),
  );

  it.effect("parse as calls through the Hermes polyfill instead of leaking as text", () =>
    Effect.gen(function* () {
      const recorded = stubProvider(
        sse([
          chunk({
            content: `<tool_call>\n${JSON.stringify({ name: "edit_deck", arguments: { title: "Q3" } })}\n</tool_call>`,
          }),
          usageChunk({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
        ]),
      );
      const parts = yield* run(noToolsRepo);
      const system = JSON.stringify(messagesOf(recorded[0]?.body)[0]?.content);
      expect(system).toContain('\\"name\\":\\"web_search\\"');
      expect(system).not.toContain("edit_deck");
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        name: "edit_deck",
        result: { edited: true },
      });
      const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));
      expect(text.join("")).toBe("");
    }),
  );
});
