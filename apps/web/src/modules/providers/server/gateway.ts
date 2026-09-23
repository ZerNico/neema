import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { AiError, LanguageModel, Prompt, Response, type Toolkit } from "effect/unstable/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import type { EmbeddingConnection } from "~/modules/knowledge/schema.ts";
import { ModelNotFound } from "~/modules/chat/errors.ts";
import {
  REASONING_EFFORTS,
  type ModelCapabilities,
  type ModelPricing,
  type ModelType,
  type ReasoningEffort,
  type ReasoningEffortFormat,
} from "../model-config.ts";
import { withHermesTools } from "./hermes-tools.ts";
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
// providers: OpenRouter forwards the upstream body verbatim, so the phrasing
// is whatever the upstream chose. Matching prose is unlovely but it is the
// only signal that exists; a miss degrades to ProviderUnreachable, how this
// failed before the retry existed.
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

const ProviderErrorMessage = Schema.Struct({ message: Schema.String });
const providerErrorMessage = (cause: unknown): string => {
  // SSE errors are plain objects: String(cause) would erase their message.
  // Read only a validated string, never serialize arbitrary provider metadata.
  const decoded = Schema.decodeUnknownOption(ProviderErrorMessage)(cause);
  return Option.isSome(decoded) ? decoded.value.message : String(cause);
};

export const isContextOverflow = (cause: unknown): boolean => {
  const text = providerErrorMessage(cause);
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

/**
 * Streamed response parts from effect/unstable/ai: text/reasoning deltas,
 * tool-call + tool-result parts (handlers run by the library), finish, etc.
 */
export type ChatStreamPart = Response.AnyPart;

// Sensitivity follows the outgoing input, not only the requested output mode.
// The adapter also restores reasoning details from tool-call/reasoning parts.
/**
 * Marks where a prompt's stable part ends, so a provider that caches only at
 * explicit points can cache everything up to it. Inert everywhere else: the
 * adapter reads only its own `openrouter` options.
 */
export const cacheAnchor = <M extends Prompt.MessageEncoded>(message: M): M => ({
  ...message,
  options: { ...message.options, cache: { anchor: true } },
});

// Claude caches only at explicit points; OpenAI, Gemini, DeepSeek, Grok and
// local servers cache a stable prefix by themselves. A relay such as 9router
// discards client markers and places its own.
const explicitCacheModel = (providerKind: string, modelKey: string) =>
  providerKind === "openrouter" && modelKey.startsWith("anthropic/");

const withCacheControl = (prompt: Prompt.Prompt): Prompt.Prompt =>
  Prompt.fromMessages(
    prompt.content.map((message) =>
      (message.role === "user" || message.role === "system") &&
      (message.options["cache"] as { anchor?: unknown } | null | undefined)?.anchor === true
        ? Prompt.makeMessage(message.role, {
            ...message,
            options: {
              ...message.options,
              openrouter: {
                ...(message.options["openrouter"] as object | null | undefined),
                cacheControl: { type: "ephemeral" },
              },
            },
          } as never)
        : message,
    ),
  );

const hasSensitivePrompt = (prompt: Prompt.Prompt): boolean =>
  prompt.content.some(
    (message) =>
      (message.role === "assistant" &&
        (message.options.openrouter?.reasoningDetails?.length ?? 0) > 0) ||
      (message.role !== "system" &&
        message.content.some(
          (part) =>
            (part.type === "file" && part.mediaType.startsWith("image/")) ||
            ((part.type === "tool-call" || part.type === "reasoning") &&
              (part.options.openrouter?.reasoningDetails?.length ?? 0) > 0),
        )),
  );

const StreamedProviderError = Schema.Struct({ code: Schema.Int });

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.String),
      context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      supported_parameters: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
      reasoning: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            supported_efforts: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
          }),
        ),
      ),
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

/**
 * Catalog prices arrive as USD-per-token decimal strings ("0.0000025");
 * the app stores USD per 1M tokens. Free models ("0") map to a zero price,
 * which is a statement, not an unknown.
 */
export const catalogPricing = (
  pricing: { prompt?: string | null; completion?: string | null } | null | undefined,
): CatalogModel["pricing"] => {
  // Number(null) is 0, so only a non-empty string is a stated price.
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
  // OpenRouter lists embedding models with `output_modalities: ["embeddings"]`
  // (no text), so they used to fall through to "chat" and never appeared as
  // embedding candidates in the picker. Plain OpenAI-compatible catalogs omit
  // the field entirely, in which case the admin still sets the type by hand.
  if (!outputModalities) return "chat";
  if (outputModalities.includes("text")) return "chat";
  if (outputModalities.includes("embeddings") || outputModalities.includes("embedding"))
    return "embedding";
  // Image/audio/video generation, reranking and speech are out of scope for the registry.
  return null;
};

// OpenRouter-style capability signals; plain OpenAI-compatible endpoints
// usually return neither field, in which case everything stays false and the
// admin toggles capabilities manually.
const inferCapabilities = (m: {
  supported_parameters?: ReadonlyArray<string> | null;
  architecture?: {
    input_modalities?: ReadonlyArray<string>;
    output_modalities?: ReadonlyArray<string>;
  };
}): ModelCapabilities => {
  const params = m.supported_parameters ?? [];
  return {
    ...(m.architecture?.output_modalities?.includes("image") ? { imageOutput: true } : {}),
    reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    tools: params.includes("tools"),
    vision: (m.architecture?.input_modalities ?? []).includes("image"),
    files: (m.architecture?.input_modalities ?? []).includes("file"),
  };
};

// Embedding responses are the OpenAI-compatible shape both provider kinds
// speak. `index` is validated rather than trusted: providers are allowed to
// return the array out of order, and silently mismatching an embedding with
// its input would corrupt the index in a way search cannot detect.
const EmbeddingsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      index: Schema.Int,
      embedding: Schema.Array(Schema.Number),
    }),
  ),
});

const EmbeddingTokenCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 }),
);
const EmbeddingUsage = Schema.Struct({
  usage: Schema.Struct({
    prompt_tokens: Schema.optionalKey(EmbeddingTokenCount),
    total_tokens: Schema.optionalKey(EmbeddingTokenCount),
  }),
});

export interface EmbeddingAttribution {
  readonly userId: string;
  readonly kind: "embedding_document" | "embedding_query";
}

export interface EmbeddingResult {
  readonly embeddings: ReadonlyArray<ReadonlyArray<number>>;
  readonly dimensions: number;
  /** Absent when the provider reported none: unknown cost, never zero. */
  readonly inputTokens: number | null;
}

/**
 * Talks to configured AI providers: model catalog for admin autocomplete, and
 * streaming chat completions for generation.
 */
export class AiGateway extends Context.Service<
  AiGateway,
  {
    /** Live model list from the provider API (autocomplete source) */
    fetchCatalog(
      providerId: string,
    ): Effect.Effect<ReadonlyArray<CatalogModel>, ProviderUnreachable | ModelNotFound>;
    /**
     * Stream one model turn for a stored model id. When a toolkit is passed,
     * the library resolves tool calls (runs handlers) within the turn and
     * emits tool-call/tool-result parts; the caller drives the multi-turn
     * loop by feeding the parts back in as prompt history.
     */
    streamChat(input: {
      imageOutput?: boolean;
      reasoningEffort?: ReasoningEffort | null;
      modelId: string;
      prompt: Prompt.Prompt;
      toolkit?: Toolkit.WithHandler<any>;
      toolChoice?: "auto" | "none" | "required";
      maxOutputTokens?: number;
    }): Stream.Stream<
      ChatStreamPart,
      ProviderUnreachable | ProviderContextOverflow | ModelNotFound
    >;
    /**
     * One bounded, tool-free model turn returning just the text. Used for
     * side generations (conversation titles, compaction summaries), never for
     * the answer itself. Still goes out as a streaming request, see the
     * implementation for why.
     */
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
    /**
     * Embeds a batch of inputs with a stored embedding model. Separate from the
     * language-model path on purpose: `OpenRouterLanguageModel` covers chat
     * completions only, while `POST /embeddings` is the shape both provider
     * kinds expose. Callers batch and bound the inputs.
     */
    /**
     * Sends one short input to `POST /embeddings` for a model that may not be
     * stored yet, and returns the vector width the provider actually produced.
     * Catalogs do not state dimensions (verified against OpenRouter), so this
     * is the only honest source. One tiny billable request; admin-only.
     */
    probeEmbeddingDimensions(input: {
      providerId: string;
      modelKey: string;
    }): Effect.Effect<{ dimensions: number }, ProviderUnreachable | ModelNotFound>;
    embed(input: {
      modelId: string;
      inputs: ReadonlyArray<string>;
      /** Rejects a model whose output does not match the expected width. */
      expectedDimensions?: number;
      expectedConnection?: EmbeddingConnection;
      attribution: EmbeddingAttribution;
      /** Runs after acquiring the shared permit, immediately before dispatch. */
      beforeDispatch?: () => Effect.Effect<void, ProviderUnreachable | ModelNotFound>;
    }): Effect.Effect<EmbeddingResult, ProviderUnreachable | ModelNotFound>;
  }
>()("chat/providers/AiGateway") {
  static readonly layer = Layer.effect(
    AiGateway,
    Effect.gen(function* () {
      const repo = yield* ProviderRepo;
      const httpClient = yield* HttpClient.HttpClient;
      const analytics = yield* AnalyticsRepo;
      const embeddingPermits = yield* Semaphore.make(KNOWLEDGE_LIMITS.embeddingConcurrency);

      const decodeModels = Schema.decodeUnknownEffect(ModelsResponse);
      const decodeEmbeddings = Schema.decodeUnknownEffect(EmbeddingsResponse);

      const fetchCatalog = Effect.fn("AiGateway.fetchCatalog")(function* (providerId: string) {
        const provider = yield* repo.getProviderWithKey(providerId);
        if (!provider) return yield* new ModelNotFound({ modelId: providerId });

        // Both supported kinds expose an OpenAI-style GET /models.
        //
        // OpenRouter's listing is text-generation only; embedding models
        // appear only when the query asks for that modality, so fetch both
        // and merge for one admin autocomplete. A plain endpoint lists
        // everything in one call, so it gets a single request.
        const base = provider.baseUrl.replace(/\/$/, "");
        const listing = (url: string) =>
          httpClient
            .execute(
              HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(provider.apiKey)),
            )
            .pipe(
              Effect.flatMap((res) => res.json),
              Effect.flatMap((json) => decodeModels(json)),
              Effect.mapError(
                (cause) => new ProviderUnreachable({ providerId, message: String(cause) }),
              ),
            );
        const pages = yield* Effect.all(
          provider.kind === "openrouter"
            ? [listing(`${base}/models`), listing(`${base}/models?output_modalities=embeddings`)]
            : [listing(`${base}/models`)],
          { concurrency: 2 },
        );
        const seen = new Set<string>();
        const data = pages
          .flatMap((page) => page.data)
          .filter((m) => !seen.has(m.id) && seen.add(m.id));

        return data.flatMap((m): CatalogModel[] => {
          const type = inferType(m.architecture?.output_modalities);
          const supportedEfforts = m.reasoning?.supported_efforts;
          return type === null
            ? []
            : [
                {
                  id: m.id,
                  name: m.name ?? m.id,
                  type,
                  contextLength: m.context_length ?? null,
                  capabilities: {
                    ...inferCapabilities(m),
                    ...(provider.kind === "openrouter" && (supportedEfforts?.length ?? 0) > 0
                      ? { reasoning: true }
                      : {}),
                    ...(provider.kind === "openrouter" && type === "chat" && supportedEfforts
                      ? {
                          reasoningEfforts: REASONING_EFFORTS.filter((effort) =>
                            supportedEfforts.includes(effort),
                          ),
                        }
                      : {}),
                  },
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
        config?: { max_tokens?: number; reasoningEffort?: ReasoningEffort | null },
        imageOutput = false,
      ) {
        const model = yield* repo.getModel(modelId);
        if (!model) return yield* new ModelNotFound({ modelId });
        const provider = yield* repo.getProviderWithKey(model.providerId);
        if (!provider) return yield* new ModelNotFound({ modelId });

        const actualImageOutput = imageOutput && model.capabilities.imageOutput === true;
        const { reasoningEffort, ...requestConfig } = config ?? {};
        const reasoningFormat: ReasoningEffortFormat =
          provider.kind === "openrouter" ? "nested" : provider.reasoningEffortFormat;
        const adapter = OpenRouterLanguageModel.model(model.modelKey, {
          ...requestConfig,
          ...(reasoningEffort && reasoningFormat === "nested"
            ? { reasoning: { effort: reasoningEffort } }
            : reasoningEffort && reasoningFormat === "flat"
              ? { reasoning_effort: reasoningEffort }
              : {}),
          ...(actualImageOutput
            ? { modalities: ["text", "image"] as const }
            : provider.kind === "openrouter"
              ? { modalities: ["text"] as const }
              : {}),
        }).pipe(
          Layer.provide(
            OpenRouterClient.layer({
              apiKey: provider.apiKey,
              apiUrl: provider.baseUrl,
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
        );
        // `capabilities.tools` means native tool calling. Without it the
        // Hermes polyfill sits between the adapter and the toolkit loop:
        // adapter → hermes → think extraction (in streamChat/generateText).
        const layer = model.capabilities.tools ? adapter : withHermesTools(adapter);
        return {
          providerId: model.providerId,
          layer,
          imageOutput: actualImageOutput,
          explicitCache: explicitCacheModel(provider.kind, model.modelKey),
        };
      });

      // One place decides which provider rejections are recoverable, so chat
      // and the side generations cannot drift apart on it.
      const classify = (providerId: string, cause: unknown) => {
        if (cause instanceof ProviderContextOverflow || cause instanceof ProviderUnreachable) {
          return cause;
        }
        const message = providerErrorMessage(cause);
        if (isContextOverflow(message)) return new ProviderContextOverflow({ providerId, message });
        // Preserve only the adapter's fixed reason tag and HTTP status for durable
        // diagnostics. Descriptions, bodies and headers can contain private data.
        const reason = AiError.isAiError(cause) ? cause.reason : undefined;
        const status = reason && "http" in reason ? reason.http?.response?.status : undefined;
        // SSE error values are plain objects, not AiErrors. Their code is a
        // provider code, not the HTTP status of the already-open stream.
        const streamedError = Schema.decodeUnknownOption(StreamedProviderError)(cause);
        return new ProviderUnreachable({
          providerId,
          message,
          ...(reason
            ? { diagnostic: { kind: reason._tag, ...(status === undefined ? {} : { status }) } }
            : Option.isSome(streamedError)
              ? { diagnostic: { kind: "ProviderStreamError", code: streamedError.value.code } }
              : {}),
        });
      };

      const requestError = (providerId: string, prompt: Prompt.Prompt, imageOutput = false) => {
        const sensitive = imageOutput || hasSensitivePrompt(prompt);
        return (cause: unknown) => {
          const error = classify(providerId, cause);
          // Provider/decode failures may quote image bytes or opaque replay signatures.
          // Preserve categories and bounded diagnostic codes, never that quoted text.
          if (!sensitive) return error;
          return error instanceof ProviderContextOverflow
            ? new ProviderContextOverflow({
                providerId,
                message: imageOutput
                  ? "The image request exceeded the provider context window."
                  : "The request exceeded the provider context window.",
              })
            : new ProviderUnreachable({
                providerId,
                message: imageOutput
                  ? "The image provider could not complete this request."
                  : "The provider could not complete this request.",
                ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
              });
        };
      };

      const streamChat = (input: {
        modelId: string;
        prompt: Prompt.Prompt;
        toolkit?: Toolkit.WithHandler<any>;
        toolChoice?: "auto" | "none" | "required";
        maxOutputTokens?: number;
        imageOutput?: boolean;
        reasoningEffort?: ReasoningEffort | null;
      }): Stream.Stream<
        ChatStreamPart,
        ProviderUnreachable | ProviderContextOverflow | ModelNotFound
      > =>
        Stream.unwrap(
          Effect.gen(function* () {
            const {
              providerId,
              layer: modelLayer,
              imageOutput,
              explicitCache,
            } = yield* resolveModel(
              input.modelId,
              {
                ...(input.maxOutputTokens === undefined
                  ? {}
                  : { max_tokens: input.maxOutputTokens }),
                ...(input.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: input.reasoningEffort }),
              },
              input.imageOutput === true,
            );
            const prompt = explicitCache ? withCacheControl(input.prompt) : input.prompt;

            const parts = input.toolkit
              ? LanguageModel.streamText({
                  prompt,
                  toolkit: input.toolkit,
                  toolChoice: input.toolChoice ?? "auto",
                })
              : LanguageModel.streamText({ prompt });

            // Always-on extractor: models emitting raw <think> blocks in text
            // (R1 distills, QwQ, local models) still feed the reasoning track.
            const provided = (imageOutput ? parts : extractThinkTags(parts)).pipe(
              Stream.provide(modelLayer),
              // Some OpenAI-compatible providers report a rejected request as
              // an SSE error value rather than failing the stream channel.
              Stream.mapEffect((part) =>
                part.type === "error"
                  ? Effect.fail(classify(providerId, part.error))
                  : Effect.succeed(part),
              ),
              Stream.mapError(requestError(providerId, input.prompt, imageOutput)),
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

      // Folded from the streaming endpoint, not `LanguageModel.generateText`:
      // its response schema requires `system_fingerprint`, which plain
      // OpenAI-compatible servers omit, so one-shot decode fails where
      // streaming works. Titles and compaction summaries must not require
      // OpenRouter specifically, so they ride the wire format every
      // generation already proves.
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
        // nothing to call, so `toolChoice` would be moot. Think extraction is
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
        ).pipe(Effect.mapError(requestError(providerId, input.prompt)));
      });

      const probeEmbeddingDimensions = Effect.fn("AiGateway.probeEmbeddingDimensions")(
        function* (input: { providerId: string; modelKey: string }) {
          const provider = yield* repo.getProviderWithKey(input.providerId);
          if (!provider?.enabled) return yield* new ModelNotFound({ modelId: input.providerId });
          const modelKey = input.modelKey.trim();
          if (!modelKey || modelKey.length > 200)
            return yield* new ProviderUnreachable({
              providerId: provider.id,
              message: "invalid model key",
              diagnostic: { kind: "InvalidRequestError" },
            });
          const request = HttpClientRequest.post(
            `${provider.baseUrl.replace(/\/$/, "")}/embeddings`,
          ).pipe(
            HttpClientRequest.bearerToken(provider.apiKey),
            HttpClientRequest.bodyJsonUnsafe({ model: modelKey, input: ["dimension probe"] }),
          );
          const response = yield* httpClient.execute(request).pipe(
            Effect.flatMap((res) =>
              res.status < 200 || res.status >= 300
                ? Effect.fail(new Error(`HTTP ${res.status}`))
                : res.json,
            ),
            Effect.flatMap((json) => decodeEmbeddings(json)),
            Effect.timeout(Duration.seconds(30)),
            // Never persist provider response bodies or credentials.
            Effect.mapError(
              () =>
                new ProviderUnreachable({
                  providerId: provider.id,
                  message:
                    "the model did not return an embedding; check the key and that it is an embedding model",
                }),
            ),
          );
          const dimensions = response.data[0]?.embedding.length ?? 0;
          if (dimensions === 0 || dimensions > 8192)
            return yield* new ProviderUnreachable({
              providerId: provider.id,
              message: "embedding response has invalid dimensions",
            });
          return { dimensions };
        },
      );

      const embed = Effect.fn("AiGateway.embed")(function* (input: {
        modelId: string;
        inputs: ReadonlyArray<string>;
        expectedDimensions?: number;
        expectedConnection?: EmbeddingConnection;
        attribution: EmbeddingAttribution;
        beforeDispatch?: () => Effect.Effect<void, ProviderUnreachable | ModelNotFound>;
      }) {
        const model = yield* repo.getModel(input.modelId);
        if (!model || !model.enabled || model.type !== "embedding" || model.access !== "public") {
          return yield* new ModelNotFound({ modelId: input.modelId });
        }
        const provider = yield* repo.getProviderWithKey(model.providerId);
        if (!provider?.enabled) return yield* new ModelNotFound({ modelId: input.modelId });
        const approved = input.expectedConnection;
        if (
          approved &&
          (approved.providerId !== provider.id ||
            approved.baseUrl !== provider.baseUrl.replace(/\/$/, "") ||
            approved.modelKey !== model.modelKey ||
            approved.modelDimensions !== model.embeddingDimensions)
        ) {
          return yield* new ProviderUnreachable({
            providerId: provider.id,
            message: "embedding connection changed; approval required",
          });
        }
        if (
          input.inputs.length > KNOWLEDGE_LIMITS.embeddingBatchSize ||
          input.inputs.some(
            (text) => !text.trim() || text.length > KNOWLEDGE_LIMITS.embeddingMaxInputChars,
          ) ||
          input.inputs.reduce((total, text) => total + text.length, 0) >
            KNOWLEDGE_LIMITS.embeddingMaxBatchChars ||
          (input.expectedDimensions !== undefined &&
            (!Number.isInteger(input.expectedDimensions) ||
              input.expectedDimensions < 1 ||
              input.expectedDimensions > 8192))
        ) {
          return yield* new ProviderUnreachable({
            providerId: provider.id,
            message: "embedding request exceeds configured input limits",
            diagnostic: { kind: "InvalidRequestError" },
          });
        }
        // No provider-neutral tokenizer exists here. Budget UTF-8 bytes as
        // tokens, plus framing headroom: deliberately conservative, especially
        // for non-Latin text. Never silently truncate immutable chunk evidence.
        if (
          model.contextLength != null &&
          input.inputs.some((text) => Buffer.byteLength(text, "utf8") + 16 > model.contextLength!)
        ) {
          return yield* new ProviderUnreachable({
            providerId: provider.id,
            message:
              "embedding input exceeds the model context budget; select a larger-context embedding model or use smaller documents",
            diagnostic: { kind: "InvalidRequestError" },
          });
        }
        const providerId = model.providerId;
        if (input.inputs.length === 0) {
          return { embeddings: [], dimensions: input.expectedDimensions ?? 0, inputTokens: 0 };
        }

        // `expectedDimensions` is what the index was approved at, used below to
        // *verify* the response, never sent as a request parameter: `dimensions`
        // asks the provider to truncate, which only Matryoshka-trained models honour;
        // others may reject or ignore it. Detect recorded the model's width, so the
        // check below is the contract.
        const request = HttpClientRequest.post(
          `${provider.baseUrl.replace(/\/$/, "")}/embeddings`,
        ).pipe(
          HttpClientRequest.bearerToken(provider.apiKey),
          HttpClientRequest.bodyJsonUnsafe({ model: model.modelKey, input: input.inputs }),
        );

        if (input.beforeDispatch) yield* input.beforeDispatch();
        let started = false;
        let inputTokens: number | null = null;
        // The finalizer surrounds dispatch and validation, not preflight or
        // permit waiting. Cancellation after dispatch may still be billable.
        return yield* Effect.gen(function* () {
          const response = yield* Effect.suspend(() => {
            started = true;
            return httpClient.execute(request);
          }).pipe(
            Effect.flatMap((res) =>
              Effect.gen(function* () {
                if (res.status < 200 || res.status >= 300)
                  return yield* Effect.fail(new Error(`HTTP ${res.status}`));
                let length = 0;
                const parts: Uint8Array[] = [];
                yield* Stream.runForEach(res.stream, (part) =>
                  Effect.gen(function* () {
                    length += part.byteLength;
                    if (length > 8 * 1024 * 1024)
                      return yield* Effect.fail(new Error("embedding response too large"));
                    parts.push(part);
                  }),
                );
                const bytes = new Uint8Array(length);
                let offset = 0;
                for (const part of parts) {
                  bytes.set(part, offset);
                  offset += part.byteLength;
                }
                return yield* Effect.try(
                  () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
                );
              }),
            ),
            Effect.flatMap((json) => {
              const usage = Schema.decodeUnknownOption(EmbeddingUsage)(json);
              if (Option.isSome(usage))
                inputTokens =
                  usage.value.usage.prompt_tokens ?? usage.value.usage.total_tokens ?? null;
              return decodeEmbeddings(json);
            }),
            Effect.timeout(Duration.seconds(45)),
            // Never persist provider response bodies, echoed inputs or credentials.
            Effect.mapError(
              () =>
                new ProviderUnreachable({
                  providerId,
                  message: "embedding request failed or timed out",
                }),
            ),
          );

          // Malformed or mismatched output is a contract failure of the model,
          // not provider weather: retrying the same request cannot change the
          // vector width it returns, so the job must settle as failed at once.
          const fail = (message: string) =>
            Effect.fail(
              new ProviderUnreachable({
                providerId,
                message,
                diagnostic: { kind: "InvalidRequestError" },
              }),
            );
          if (response.data.length !== input.inputs.length) {
            return yield* fail(
              `embedding response covered ${response.data.length} of ${input.inputs.length} inputs`,
            );
          }

          const byIndex = new Map(response.data.map((row) => [row.index, row]));
          if (byIndex.size !== input.inputs.length)
            return yield* fail("embedding response repeats an input index");
          const ordered = [];
          for (let index = 0; index < input.inputs.length; index++) {
            const row = byIndex.get(index);
            if (!row) return yield* fail(`embedding response is missing input ${index}`);
            ordered.push(row);
          }

          const dimensions = ordered[0]!.embedding.length;
          if (dimensions === 0 || dimensions > 8192)
            return yield* fail("embedding response has invalid dimensions");
          if (input.expectedDimensions !== undefined && dimensions !== input.expectedDimensions) {
            return yield* fail(
              `embedding model returned ${dimensions} dimensions, expected ${input.expectedDimensions}`,
            );
          }
          for (const row of ordered) {
            if (row.embedding.length !== dimensions) {
              return yield* fail("embedding response mixes vector widths");
            }
            // A NaN or Infinity poisons every distance this vector takes part in.
            if (
              !row.embedding.every((value) => Number.isFinite(value)) ||
              row.embedding.every((value) => value === 0)
            ) {
              return yield* fail("embedding response contains a non-finite value");
            }
          }

          return {
            embeddings: ordered.map((row) => row.embedding),
            dimensions,
            inputTokens,
          } satisfies EmbeddingResult;
        }).pipe(
          Effect.onExit((exit) => {
            if (!started) return Effect.void;
            const calculatedCost =
              inputTokens !== null &&
              model.pricing &&
              Number.isFinite(model.pricing.input) &&
              model.pricing.input >= 0
                ? (inputTokens * model.pricing.input) / 1_000_000
                : null;
            const cost =
              calculatedCost !== null && Number.isFinite(calculatedCost) ? calculatedCost : null;
            return analytics
              .record({
                ...input.attribution,
                modelId: model.id,
                modelName: model.displayName,
                status: Exit.isSuccess(exit)
                  ? "complete"
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? "aborted"
                    : "error",
                inputTokens: inputTokens ?? 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                usageComplete: inputTokens !== null,
                cost,
                costSource: cost === null ? null : "pricing",
              })
              .pipe(
                Effect.catchCause(() => Effect.logError("embedding usage could not be recorded")),
              );
          }),
        );
      });

      return AiGateway.of({
        fetchCatalog,
        probeEmbeddingDimensions,
        streamChat,
        generateText,
        // Shared by indexing and query requests, not one semaphore per caller.
        embed: (input) => embeddingPermits.withPermits(1)(embed(input)),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
