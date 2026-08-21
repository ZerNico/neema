import { OpenRouterClient } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Schema, Stream } from "effect";
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
}

export interface ChatDelta {
  readonly kind: "text" | "reasoning";
  readonly text: string;
}

export interface ChatTurnMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

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
    // Stream a chat completion for a stored model id
    streamChat(input: {
      modelId: string;
      messages: ReadonlyArray<ChatTurnMessage>;
    }): Stream.Stream<ChatDelta, ProviderUnreachable | ModelNotFound>;
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
        messages: ReadonlyArray<ChatTurnMessage>;
      }): Stream.Stream<ChatDelta, ProviderUnreachable | ModelNotFound> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const model = yield* repo.getModel(input.modelId);
            if (!model) return yield* new ModelNotFound({ modelId: input.modelId });
            const provider = yield* repo.getProviderWithKey(model.providerId);
            if (!provider) return yield* new ModelNotFound({ modelId: input.modelId });

            const clientLayer = OpenRouterClient.layer({
              apiKey: provider.apiKey,
              apiUrl: provider.baseUrl,
            }).pipe(Layer.provide(FetchHttpClient.layer));

            const raw = Effect.gen(function* () {
              const client = yield* OpenRouterClient.OpenRouterClient;
              const [, chunks] = yield* client.createChatCompletionStream({
                model: model.modelKey,
                messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
              });
              // Providers with hidden reasoning (e.g. OpenAI o-series) still
              // stream reasoning_details entries — just encrypted/redacted.
              // Emit a single empty "reasoning" marker for those so the UI can
              // show a thinking indicator without any readable trace.
              let signaledHiddenReasoning = false;
              return chunks.pipe(
                Stream.map((chunk): ChatDelta[] => {
                  const deltas: ChatDelta[] = [];

                  let reasoning = chunk.choices.map((c) => c.delta.reasoning ?? "").join("");
                  let sawHidden = false;
                  for (const choice of chunk.choices) {
                    for (const detail of choice.delta.reasoning_details ?? []) {
                      if (detail.type === "reasoning.text" && detail.text) {
                        if (!choice.delta.reasoning) reasoning += detail.text;
                      } else if (detail.type === "reasoning.summary" && detail.summary) {
                        if (!choice.delta.reasoning) reasoning += detail.summary;
                      } else if (detail.type === "reasoning.encrypted") {
                        sawHidden = true;
                      }
                    }
                  }
                  if (reasoning === "[REDACTED]") {
                    reasoning = "";
                    sawHidden = true;
                  }

                  if (reasoning.length > 0) {
                    deltas.push({ kind: "reasoning", text: reasoning });
                  } else if (sawHidden && !signaledHiddenReasoning) {
                    signaledHiddenReasoning = true;
                    deltas.push({ kind: "reasoning", text: "" });
                  }

                  const text = chunk.choices.map((c) => c.delta.content ?? "").join("");
                  if (text.length > 0) deltas.push({ kind: "text", text });
                  return deltas;
                }),
                Stream.flattenIterable,
              );
            });

            // Always-on extractor: models emitting raw <think> blocks in text
            // (R1 distills, QwQ, local models) still feed the reasoning track.
            return extractThinkTags(Stream.unwrap(raw)).pipe(
              Stream.provide(clientLayer),
              Stream.mapError(
                (cause) =>
                  new ProviderUnreachable({
                    providerId: model.providerId,
                    message: String(cause),
                  }),
              ),
            );
          }),
        );

      return AiGateway.of({ fetchCatalog, streamChat });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
