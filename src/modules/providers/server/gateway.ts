import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, type Prompt, type Response, type Toolkit } from "effect/unstable/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ModelNotFound } from "~/modules/chat/errors.ts";
import { ProviderRepo } from "./repo.ts";
import { extractThinkTags } from "./think-extractor.ts";

export class ProviderUnreachable extends Schema.TaggedError<ProviderUnreachable>()(
  "ProviderUnreachable",
  { providerId: Schema.String, message: Schema.String },
) {}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly type: "chat" | "embedding" | "image" | "audio";
  readonly contextLength: number | null;
  readonly capabilities: ModelCapabilities;
  /** USD per 1M tokens, when the catalog carries prices (OpenRouter does). */
  readonly pricing: { input: number; output: number } | null;
}

export interface ModelCapabilities {
  readonly reasoning: boolean;
  readonly tools: boolean;
  readonly vision: boolean;
  readonly files: boolean;
}

// Streamed response parts from effect/unstable/ai: text/reasoning deltas,
// tool-call + tool-result parts (handlers run by the library), finish, etc.
export type ChatStreamPart = Response.AnyPart;

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.String),
      context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      supported_parameters: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
      // OpenRouter: USD per token, as decimal strings. Generic providers omit it.
      pricing: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
            completion: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
      architecture: Schema.optionalKey(
        Schema.Struct({
          input_modalities: Schema.optionalKey(Schema.Array(Schema.String)),
          output_modalities: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
});

// Catalog prices arrive as USD-per-token decimal strings ("0.0000025");
// the app stores USD per 1M tokens. Free models ("0") map to a zero price,
// which is a statement, not an unknown.
const catalogPricing = (
  pricing: { prompt?: string | null; completion?: string | null } | null | undefined,
): CatalogModel["pricing"] => {
  // Number(null) is 0 — only a non-empty string is a stated price.
  const parse = (v: string | null | undefined) =>
    typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  const input = parse(pricing?.prompt);
  const output = parse(pricing?.completion);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input: input * 1_000_000, output: output * 1_000_000 };
};

const inferType = (outputModalities: ReadonlyArray<string> | undefined): CatalogModel["type"] => {
  if (!outputModalities || outputModalities.includes("text")) return "chat";
  if (outputModalities.includes("image")) return "image";
  if (outputModalities.includes("audio")) return "audio";
  return "chat";
};

// OpenRouter-style capability signals; plain OpenAI-compatible endpoints
// usually return neither field, in which case everything stays false and the
// admin toggles capabilities manually.
const inferCapabilities = (m: {
  supported_parameters?: ReadonlyArray<string> | null;
  architecture?: { input_modalities?: ReadonlyArray<string> };
}): ModelCapabilities => {
  const params = m.supported_parameters ?? [];
  return {
    reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    tools: params.includes("tools"),
    vision: (m.architecture?.input_modalities ?? []).includes("image"),
    files: (m.architecture?.input_modalities ?? []).includes("file"),
  };
};

// Talks to configured AI providers: model catalog for admin autocomplete, and
// streaming chat completions for generation.
export class AiGateway extends Context.Service<
  AiGateway,
  {
    // Live model list from the provider API (autocomplete source)
    fetchCatalog(
      providerId: string,
    ): Effect.Effect<ReadonlyArray<CatalogModel>, ProviderUnreachable | ModelNotFound>;
    // Stream one model turn for a stored model id. When a toolkit is passed,
    // the library resolves tool calls (runs handlers) within the turn and
    // emits tool-call/tool-result parts; the caller drives the multi-turn
    // loop by feeding the parts back in as prompt history.
    streamChat(input: {
      modelId: string;
      prompt: Prompt.Prompt;
      toolkit?: Toolkit.WithHandler<any>;
      toolChoice?: "auto" | "none" | "required";
    }): Stream.Stream<ChatStreamPart, ProviderUnreachable | ModelNotFound>;
    // One bounded, tool-free model turn returning just the text. Used for
    // side generations (conversation titles), never for the answer itself.
    generateText(input: { modelId: string; prompt: Prompt.Prompt }): Effect.Effect<
      {
        text: string;
        usage: Response.Usage;
        /** The finish part's provider metadata (OpenRouter: raw usage incl. cost). */
        finishMetadata: unknown;
      },
      ProviderUnreachable | ModelNotFound
    >;
  }
>()("chat/providers/AiGateway") {
  static readonly layer = Layer.effect(
    AiGateway,
    Effect.gen(function* () {
      const repo = yield* ProviderRepo;
      const httpClient = yield* HttpClient.HttpClient;

      const decodeModels = Schema.decodeUnknownEffect(ModelsResponse);

      const fetchCatalog = Effect.fn("AiGateway.fetchCatalog")(function* (providerId: string) {
        const provider = yield* repo.getProviderWithKey(providerId);
        if (!provider) return yield* new ModelNotFound({ modelId: providerId });

        // Both supported kinds expose an OpenAI-style GET /models
        const request = HttpClientRequest.get(`${provider.baseUrl.replace(/\/$/, "")}/models`).pipe(
          HttpClientRequest.bearerToken(provider.apiKey),
        );

        const response = yield* httpClient.execute(request).pipe(
          Effect.flatMap((res) => res.json),
          Effect.flatMap((json) => decodeModels(json)),
          Effect.mapError(
            (cause) => new ProviderUnreachable({ providerId, message: String(cause) }),
          ),
        );

        return response.data.map((m): CatalogModel => ({
          id: m.id,
          name: m.name ?? m.id,
          type: inferType(m.architecture?.output_modalities),
          contextLength: m.context_length ?? null,
          capabilities: inferCapabilities(m),
          pricing: catalogPricing(m.pricing),
        }));
      });

      // Streaming and one-shot must not drift apart on credentials, base url
      // or model key, so both resolve the provider layer through here.
      // OpenRouterLanguageModel maps deltas/reasoning_details (incl. encrypted
      // → "[REDACTED]"), fragmented tool calls, and usage to
      // Response.StreamParts, and replays reasoning signatures on
      // continuation turns.
      const resolveModel = Effect.fn("AiGateway.resolveModel")(function* (modelId: string) {
        const model = yield* repo.getModel(modelId);
        if (!model) return yield* new ModelNotFound({ modelId });
        const provider = yield* repo.getProviderWithKey(model.providerId);
        if (!provider) return yield* new ModelNotFound({ modelId });

        const layer = OpenRouterLanguageModel.model(model.modelKey).pipe(
          Layer.provide(
            OpenRouterClient.layer({
              apiKey: provider.apiKey,
              apiUrl: provider.baseUrl,
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
        );
        return { providerId: model.providerId, layer };
      });

      const streamChat = (input: {
        modelId: string;
        prompt: Prompt.Prompt;
        toolkit?: Toolkit.WithHandler<any>;
        toolChoice?: "auto" | "none" | "required";
      }): Stream.Stream<ChatStreamPart, ProviderUnreachable | ModelNotFound> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { providerId, layer: modelLayer } = yield* resolveModel(input.modelId);

            const parts = input.toolkit
              ? LanguageModel.streamText({
                  prompt: input.prompt,
                  toolkit: input.toolkit,
                  toolChoice: input.toolChoice ?? "auto",
                })
              : LanguageModel.streamText({ prompt: input.prompt });

            // Always-on extractor: models emitting raw <think> blocks in text
            // (R1 distills, QwQ, local models) still feed the reasoning track.
            const provided = extractThinkTags(parts).pipe(
              Stream.provide(modelLayer),
              Stream.mapError(
                (cause) => new ProviderUnreachable({ providerId, message: String(cause) }),
              ),
            );
            // Toolkit handlers are fully provided by the executor before they
            // reach the gateway, so no requirements remain at runtime.
            return provided as Stream.Stream<ChatStreamPart, ProviderUnreachable, never>;
          }),
        );

      const generateText = Effect.fn("AiGateway.generateText")(function* (input: {
        modelId: string;
        prompt: Prompt.Prompt;
      }) {
        const { providerId, layer: modelLayer } = yield* resolveModel(input.modelId);
        const response = yield* LanguageModel.generateText({
          prompt: input.prompt,
          toolChoice: "none",
        }).pipe(
          Effect.provide(modelLayer),
          Effect.mapError(
            (cause) => new ProviderUnreachable({ providerId, message: String(cause) }),
          ),
        );
        return {
          text: response.text,
          usage: response.usage,
          finishMetadata: response.content.find((part) => part.type === "finish")?.metadata,
        };
      });

      return AiGateway.of({ fetchCatalog, streamChat, generateText });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
