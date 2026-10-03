import { Effect, Layer, Stream } from "effect";
import { it } from "vitest";
import { LanguageModel, type Prompt, type Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { makeConnection, type ModelCall } from "./connection.ts";
import { layer } from "./language-model.ts";
import type { PresetId, ProviderSettings } from "./preset.ts";

/** Chat Completions SSE, `[DONE]` included unless told otherwise. */
export const chatSse = (chunks: ReadonlyArray<unknown>, done = true) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
  (done ? "data: [DONE]\n\n" : "");

/** Responses SSE: every event names its type. */
export const responsesSse = (events: ReadonlyArray<{ type: string }>) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

export const delta = (value: Record<string, unknown>, finish?: string) => ({
  id: "gen-1",
  model: "vendor/model",
  choices: [{ index: 0, delta: value, ...(finish ? { finish_reason: finish } : {}) }],
});

export interface Exchange {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

type Answer =
  | string
  | { status: number; body: string; headers?: Record<string, string> }
  /** A stream the server never closes after sending this. */
  | { open: string };

/**
 * Streams calls against a synthetic server: each request gets the next
 * scripted answer, and every request is recorded as it was sent.
 */
export const harness = (input: {
  readonly preset: PresetId;
  readonly baseUrl?: string;
  readonly apiKey?: string | null;
  readonly settings?: ProviderSettings;
  readonly call?: Partial<ModelCall>;
  readonly answers: ReadonlyArray<Answer>;
}) => {
  const exchanges: Exchange[] = [];
  const answers = [...input.answers];
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    exchanges.push({
      url: String(url instanceof Request ? url.url : url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(
        typeof init?.body === "string"
          ? init.body
          : new TextDecoder().decode(init?.body as BufferSource),
      ),
    });
    const next = answers.shift() ?? "";
    if (typeof next === "string")
      return new Response(next, { headers: { "content-type": "text/event-stream" } });
    if ("open" in next)
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode(next.open)),
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    return new Response(next.body, { status: next.status, headers: next.headers ?? {} });
  };
  const connection = makeConnection({
    provider: "p1",
    preset: input.preset,
    baseUrl: input.baseUrl ?? "https://provider.test/v1",
    apiKey: input.apiKey === undefined ? "sk-test" : input.apiKey,
    settings: input.settings ?? null,
  })!;
  const model = layer(connection, {
    model: "vendor/model",
    capabilities: { reasoning: false, tools: true },
    ...input.call,
  }).pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ),
  );
  const stream = (
    prompt: Prompt.RawInput,
    toolkit?: Toolkit.WithHandler<any>,
    toolChoice: LanguageModel.ToolChoice<any> = "auto",
  ) =>
    (toolkit
      ? LanguageModel.streamText({ prompt, toolkit, toolChoice })
      : LanguageModel.streamText({ prompt })
    ).pipe(
      Stream.runCollect,
      Effect.map((parts) => Array.from(parts)),
      Effect.provide(model),
    );
  return { exchanges, stream, connection };
};

export const textOf = (
  parts: ReadonlyArray<{ type: string; delta?: string }>,
  type = "text-delta",
) => parts.flatMap((part) => (part.type === type && part.delta ? [part.delta] : [])).join("");

/**
 * A vitest case running an Effect: this package's tests use plain vitest. A
 * toolkit typed `any` leaves its context unknown; handlers are all provided.
 */
export const effect = (name: string, body: () => Effect.Effect<unknown, unknown, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.asVoid) as Effect.Effect<void, unknown>));
