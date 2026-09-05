import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Prompt } from "effect/unstable/ai";
import { vi } from "vitest";
import { runtimeContextMessage } from "~/modules/chat/server/runtime-context.ts";
import { ProviderRepo } from "./repo.ts";
import { AiGateway, catalogPricing, inferType } from "./gateway.ts";

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
const requests: Array<{ url: string; body: unknown }> = [];
let responseBody = "";

vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
  requests.push({
    url: String(input instanceof Request ? input.url : input),
    body: JSON.parse(
      typeof init?.body === "string"
        ? init.body
        : new TextDecoder().decode(init?.body as BufferSource),
    ),
  });
  return Promise.resolve(
    new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
});

const stubProvider = (body: string) => {
  requests.length = 0;
  responseBody = body;
  return requests;
};

const repoStub = Layer.succeed(ProviderRepo)(
  ProviderRepo.of({
    getModel: () => Effect.succeed({ id: "m1", providerId: "p1", modelKey: "vendor/model" }),
    getProviderWithKey: () =>
      Effect.succeed({ id: "p1", apiKey: "sk-test", baseUrl: "https://provider.test/v1" }),
    // The gateway reaches for nothing else.
  } as unknown as ProviderRepo["Service"]),
);

const generate = Effect.flatMap(AiGateway, (gateway) =>
  gateway.generateText({ modelId: "m1", prompt: Prompt.make("Summarize this") }),
).pipe(Effect.provide(AiGateway.layer.pipe(Layer.provide(repoStub))));

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
        ).pipe(Effect.provide(AiGateway.layer.pipe(Layer.provide(repoStub))));
        expect(recorded[0]?.body).toMatchObject({
          messages: [
            { role: "system", content: [{ type: "text", text: "Stable policy" }] },
            { role: "user", content: "Earlier question" },
            { role: "assistant", content: "Earlier answer" },
            { role: "user", content: "What day is it?" },
            { role: "user", content: clock.content },
          ],
        });
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
      // What `addFinishUsage` reads as "no usage seen" — no ledger row, rather
      // than a failed title or a lost compaction summary.
      expect(result.usage.inputTokens.total).toBeUndefined();
      expect(result.usage.outputTokens.total).toBeUndefined();
    }),
  );
});
