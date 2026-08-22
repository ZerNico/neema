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
      architecture: Schema.optionalKey(
        Schema.Struct({
          input_modalities: Schema.optionalKey(Schema.Array(Schema.String)),
          output_modalities: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
});

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
        }));
      });

      const streamChat = (input: {
        modelId: string;
        prompt: Prompt.Prompt;
        toolkit?: Toolkit.WithHandler<any>;
        toolChoice?: "auto" | "none" | "required";
      }): Stream.Stream<ChatStreamPart, ProviderUnreachable | ModelNotFound> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const model = yield* repo.getModel(input.modelId);
            if (!model) return yield* new ModelNotFound({ modelId: input.modelId });
            const provider = yield* repo.getProviderWithKey(model.providerId);
            if (!provider) return yield* new ModelNotFound({ modelId: input.modelId });

            // OpenRouterLanguageModel maps deltas/reasoning_details (incl.
            // encrypted → "[REDACTED]"), fragmented tool calls, and usage to
            // Response.StreamParts, and replays reasoning signatures on
            // continuation turns.
            const modelLayer = OpenRouterLanguageModel.model(model.modelKey).pipe(
              Layer.provide(
                OpenRouterClient.layer({
                  apiKey: provider.apiKey,
                  apiUrl: provider.baseUrl,
                }),
              ),
              Layer.provide(FetchHttpClient.layer),
            );

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
                (cause) =>
                  new ProviderUnreachable({
                    providerId: model.providerId,
                    message: String(cause),
                  }),
              ),
            );
            // Toolkit handlers are fully provided by the executor before they
            // reach the gateway, so no requirements remain at runtime.
            return provided as Stream.Stream<ChatStreamPart, ProviderUnreachable, never>;
          }),
        );

      return AiGateway.of({ fetchCatalog, streamChat });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
