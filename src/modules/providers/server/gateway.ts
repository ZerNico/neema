import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { AiError, LanguageModel, type Prompt, Response, type Toolkit } from "effect/unstable/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ModelNotFound } from "~/modules/chat/errors.ts";
import type { ModelCapabilities, ModelPricing, ModelType } from "../model-config.ts";
import { ProviderRepo } from "./repo.ts";
import { extractThinkTags } from "./think-extractor.ts";

export class ProviderUnreachable extends Schema.TaggedError<ProviderUnreachable>()(
  "ProviderUnreachable",
  {
    providerId: Schema.String,
    message: Schema.String,
    diagnostic: Schema.optionalKey(
      Schema.Struct({
        kind: Schema.Literals([
          "RateLimitError",
          "QuotaExhaustedError",
          "AuthenticationError",
          "ContentPolicyError",
          "InvalidRequestError",
          "InternalProviderError",
          "NetworkError",
          "InvalidOutputError",
          "StructuredOutputError",
          "UnsupportedSchemaError",
          "UnknownError",
          "ToolNotFoundError",
          "ToolParameterValidationError",
          "InvalidToolResultError",
          "ToolResultEncodingError",
          "ToolConfigurationError",
          "ToolkitRequiredError",
          "InvalidUserInputError",
          "ProviderStreamError",
        ]),
        code: Schema.optionalKey(Schema.Int),
        status: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
        ),
      }),
    ),
  },
) {}

/**
 * The prompt did not fit the model's context window. Split out of
 * `ProviderUnreachable` because it is the one provider rejection the caller
 * can actually do something about: shrink the transcript and try again
 * (see `streaming.ts`). Everything else stays unreachable.
 */
export class ProviderContextOverflow extends Schema.TaggedError<ProviderContextOverflow>()(
  "ProviderContextOverflow",
  { providerId: Schema.String, message: Schema.String },
) {}

// There is no machine-readable code for this across OpenAI-compatible
// providers — OpenRouter forwards the upstream body verbatim, so the phrasing
// is whatever the upstream chose. Matching prose is unlovely but it is the
// only signal that exists; a miss degrades to ProviderUnreachable, which is
// how this failed before the retry existed.
const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context window/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many (?:input )?tokens/i,
  /reduce the length of the (?:messages|prompt|input)/i,
  /exceeds? the (?:model's )?(?:maximum )?(?:input )?token limit/i,
];

export const isContextOverflow = (cause: unknown): boolean => {
  const text = String(cause);
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
};

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly type: ModelType;
  readonly contextLength: number | null;
  readonly capabilities: ModelCapabilities;
  /** USD per 1M tokens, when the catalog carries prices (OpenRouter does). */
  readonly pricing: ModelPricing | null;
}

// Streamed response parts from effect/unstable/ai: text/reasoning deltas,
// tool-call + tool-result parts (handlers run by the library), finish, etc.
export type ChatStreamPart = Response.AnyPart;

const StreamedProviderError = Schema.Struct({ code: Schema.Int });

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

const parseCatalogPrice = (value: string | null | undefined) =>
  typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;

// Catalog prices arrive as USD-per-token decimal strings ("0.0000025");
// the app stores USD per 1M tokens. Free models ("0") map to a zero price,
// which is a statement, not an unknown.
export const catalogPricing = (
  pricing: { prompt?: string | null; completion?: string | null } | null | undefined,
): CatalogModel["pricing"] => {
  // Number(null) is 0 — only a non-empty string is a stated price.
  const input = parseCatalogPrice(pricing?.prompt);
  const output = parseCatalogPrice(pricing?.completion);
  if (!Number.isFinite(input)) return null;
  return {
    input: input * 1_000_000,
    output: Number.isFinite(output) ? output * 1_000_000 : null,
  };
};

export const inferType = (
  outputModalities: ReadonlyArray<string> | undefined,
): ModelType | null => {
  if (!outputModalities || outputModalities.includes("text")) return "chat";
  // Image/audio generation is intentionally out of scope for the registry for now.
  if (outputModalities.includes("image") || outputModalities.includes("audio")) return null;
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
      maxOutputTokens?: number;
    }): Stream.Stream<
      ChatStreamPart,
      ProviderUnreachable | ProviderContextOverflow | ModelNotFound
    >;
    // One bounded, tool-free model turn returning just the text. Used for
    // side generations (conversation titles, compaction summaries), never for
    // the answer itself. Still goes out as a streaming request — see the
    // implementation for why.
    generateText(input: {
      modelId: string;
      prompt: Prompt.Prompt;
      /** Bounds the side generation; omitted leaves the provider default. */
      maxOutputTokens?: number;
    }): Effect.Effect<
      {
        text: string;
        usage: Response.Usage;
        /** The finish part's provider metadata (OpenRouter: raw usage incl. cost). */
        finishMetadata: unknown;
      },
      ProviderUnreachable | ProviderContextOverflow | ModelNotFound
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

        return response.data.flatMap((m): CatalogModel[] => {
          const type = inferType(m.architecture?.output_modalities);
          return type === null
            ? []
            : [
                {
                  id: m.id,
                  name: m.name ?? m.id,
                  type,
                  contextLength: m.context_length ?? null,
                  capabilities: inferCapabilities(m),
                  pricing: catalogPricing(m.pricing),
                },
              ];
        });
      });

      // Streaming and one-shot must not drift apart on credentials, base url
      // or model key, so both resolve the provider layer through here.
      // OpenRouterLanguageModel maps deltas/reasoning_details (incl. encrypted
      // → "[REDACTED]"), fragmented tool calls, and usage to
      // Response.StreamParts, and replays reasoning signatures on
      // continuation turns.
      const resolveModel = Effect.fn("AiGateway.resolveModel")(function* (
        modelId: string,
        config?: { max_tokens?: number },
      ) {
        const model = yield* repo.getModel(modelId);
        if (!model) return yield* new ModelNotFound({ modelId });
        const provider = yield* repo.getProviderWithKey(model.providerId);
        if (!provider) return yield* new ModelNotFound({ modelId });

        const layer = OpenRouterLanguageModel.model(model.modelKey, config ?? {}).pipe(
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

      // One place decides which provider rejections are recoverable, so chat
      // and the side generations cannot drift apart on it.
      const classify = (providerId: string, cause: unknown) => {
        if (cause instanceof ProviderContextOverflow || cause instanceof ProviderUnreachable) {
          return cause;
        }
        if (isContextOverflow(cause))
          return new ProviderContextOverflow({ providerId, message: String(cause) });
        // Preserve only the adapter's fixed reason tag and HTTP status for durable
        // diagnostics. Descriptions, bodies and headers can contain private data.
        const reason = AiError.isAiError(cause) ? cause.reason : undefined;
        const status = reason && "http" in reason ? reason.http?.response?.status : undefined;
        // SSE error values are plain objects, not AiErrors. Their code is a
        // provider code, not the HTTP status of the already-open stream.
        const streamedError = Schema.decodeUnknownOption(StreamedProviderError)(cause);
        return new ProviderUnreachable({
          providerId,
          message: String(cause),
          ...(reason
            ? { diagnostic: { kind: reason._tag, ...(status === undefined ? {} : { status }) } }
            : Option.isSome(streamedError)
              ? { diagnostic: { kind: "ProviderStreamError", code: streamedError.value.code } }
              : {}),
        });
      };

      const streamChat = (input: {
        modelId: string;
        prompt: Prompt.Prompt;
        toolkit?: Toolkit.WithHandler<any>;
        toolChoice?: "auto" | "none" | "required";
        maxOutputTokens?: number;
      }): Stream.Stream<
        ChatStreamPart,
        ProviderUnreachable | ProviderContextOverflow | ModelNotFound
      > =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { providerId, layer: modelLayer } = yield* resolveModel(
              input.modelId,
              input.maxOutputTokens === undefined ? {} : { max_tokens: input.maxOutputTokens },
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
              // Some OpenAI-compatible providers report a rejected request as
              // an SSE error value rather than failing the stream channel.
              Stream.mapEffect((part) =>
                part.type === "error"
                  ? Effect.fail(classify(providerId, part.error))
                  : Effect.succeed(part),
              ),
              Stream.mapError((cause) => classify(providerId, cause)),
            );
            // Toolkit handlers are fully provided by the executor before they
            // reach the gateway, so no requirements remain at runtime.
            return provided as Stream.Stream<
              ChatStreamPart,
              ProviderUnreachable | ProviderContextOverflow,
              never
            >;
          }),
        );

      type SideGeneration = { text: string; usage: Response.Usage; finishMetadata: unknown };

      // Folded from the streaming endpoint rather than taken from
      // `LanguageModel.generateText`, which posts a non-streaming completion:
      // its response schema requires `system_fingerprint`, a field plain
      // OpenAI-compatible servers omit, so a one-shot call fails to decode
      // against providers whose streaming path works perfectly (the streaming
      // chunk schema marks the same field optional). Titles and compaction
      // summaries must not be the only things in the app that need a provider
      // to be OpenRouter, so they ride the wire format every generation
      // already proves.
      const generateText = Effect.fn("AiGateway.generateText")(function* (input: {
        modelId: string;
        prompt: Prompt.Prompt;
        maxOutputTokens?: number;
      }) {
        const { providerId, layer: modelLayer } = yield* resolveModel(
          input.modelId,
          input.maxOutputTokens === undefined ? {} : { max_tokens: input.maxOutputTokens },
        );
        // No toolkit, so the request carries no tools and the model has
        // nothing to call — `toolChoice` would be moot. Think extraction is
        // shared with `streamChat` for the same reason: a <think> block is
        // never part of a title or a summary.
        const stream = extractThinkTags(LanguageModel.streamText({ prompt: input.prompt })).pipe(
          Stream.provide(modelLayer),
        );

        return yield* Stream.runFoldEffect(
          stream,
          (): SideGeneration => ({
            text: "",
            // Zeroed rather than absent: a provider that never sends usage
            // bills nothing instead of failing the side generation.
            usage: new Response.Usage({ inputTokens: {}, outputTokens: {} }),
            finishMetadata: undefined,
          }),
          (acc: SideGeneration, part): Effect.Effect<SideGeneration, unknown> => {
            switch (part.type) {
              case "text-delta":
                return Effect.succeed({ ...acc, text: acc.text + part.delta });
              case "finish":
                return Effect.succeed({
                  ...acc,
                  usage: part.usage,
                  finishMetadata: part.metadata,
                });
              // Same treatment as the streaming path: the provider's own
              // payload, classified below like any other transport failure.
              case "error":
                return Effect.fail(part.error);
              default:
                return Effect.succeed(acc);
            }
          },
        ).pipe(Effect.mapError((cause) => classify(providerId, cause)));
      });

      return AiGateway.of({ fetchCatalog, streamChat, generateText });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
