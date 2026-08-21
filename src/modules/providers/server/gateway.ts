import { OpenRouterClient } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ModelNotFound } from "~/modules/chat/errors.ts";
import { ProviderRepo } from "./repo.ts";

export class ProviderUnreachable extends Schema.TaggedError<ProviderUnreachable>()(
  "ProviderUnreachable",
  { providerId: Schema.String, message: Schema.String },
) {}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly type: "chat" | "embedding" | "image" | "audio";
  readonly contextLength: number | null;
}

export interface ChatDelta {
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
      architecture: Schema.optionalKey(
        Schema.Struct({
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
              return chunks.pipe(
                Stream.map((chunk) => ({
                  text: chunk.choices.map((c) => c.delta.content ?? "").join(""),
                })),
                Stream.filter((delta) => delta.text.length > 0),
              );
            });

            return Stream.unwrap(raw).pipe(
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
