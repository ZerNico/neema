import {
  Catalog,
  effectiveSettings,
  endpoint,
  formatFor,
  getPreset,
  isSensitivePrompt,
  jsonRequest,
  layer as modelClientLayer,
  makeConnection,
  type Connection,
  type Credentials,
} from "@chat/model-client";
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { AiError, LanguageModel, Prompt, Response, type Toolkit } from "effect/unstable/ai";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import type { EmbeddingConnection } from "~/modules/knowledge/schema.ts";
import type { ScanModelConnection } from "~/modules/tools/schema.ts";
import { ModelNotFound } from "~/modules/chat/errors.ts";
import { decodeAwsKeys } from "../aws-keys.ts";
import {
  EMPTY_CAPABILITIES,
  type ModelCapabilities,
  type ModelFormat,
  type ModelPricing,
  type ModelType,
  type ReasoningEffort,
} from "../model-config.ts";
import { HermesCallableTools, withHermesTools } from "./hermes-tools.ts";
import { ProviderRepo, type ProviderWithKey } from "./repo.ts";
import { parseRetryAfter } from "~/server/retry-after.ts";

/**
 * What an embedding answer's status means for the queue: a rate limit pauses
 * it, a provider fault is retried later, anything else is the request's own
 * fault and would fail the same way again.
 */
const ProviderErrorBody = Schema.Struct({
  error: Schema.Struct({ message: Schema.String }),
});
const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const embeddingDiagnostic = (status: number, retryAfter: string | undefined) => {
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(retryAfter);
    return {
      kind: "RateLimitError" as const,
      status,
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    };
  }
  if (status >= 500 || status === 408) return { kind: "InternalProviderError" as const, status };
  // A key an admin will fix: waiting is right, failing every page at once is not.
  if (status === 401 || status === 403) return { kind: "AuthenticationError" as const, status };
  return { kind: "InvalidRequestError" as const, status };
};
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
        /** From a rate limit's `Retry-After`, when the provider sent one. */
        retryAfterMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
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
/** What a side generation repeats of a chat request; see `generateText`. */
export interface SideGenerationRequest {
  readonly toolkit?: Toolkit.WithHandler<any> | undefined;
  readonly toolChoice?: ChatToolChoice | undefined;
  readonly reasoningEffort?: ReasoningEffort | null | undefined;
  readonly cacheKey?: string | undefined;
}

/** Which tools a chat turn advertises; see `streamChat`. */
export type ChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly mode?: "auto" | "required"; readonly oneOf: ReadonlyArray<string> };

export const cacheAnchor = <M extends Prompt.MessageEncoded>(message: M): M => ({
  ...message,
  options: { ...message.options, cache: { anchor: true } },
});

/** `cacheAnchor` for an already-built prompt: marks its last message. */
export const anchorLastMessage = (prompt: Prompt.Prompt): Prompt.Prompt => {
  const last = prompt.content.at(-1);
  if (!last) return prompt;
  return Prompt.fromMessages([
    ...prompt.content.slice(0, -1),
    Prompt.makeMessage(last.role, {
      ...last,
      options: { ...last.options, cache: { anchor: true } },
    } as never),
  ]);
};

const StreamedProviderError = Schema.Struct({ code: Schema.Int });
/** Responses stream errors name their kind as a string; only these known codes are kept. */
const StreamedErrorCode = Schema.Struct({ code: Schema.String });
const RESPONSES_ERROR_KINDS: Record<
  string,
  "RateLimitError" | "QuotaExhaustedError" | "AuthenticationError" | "InternalProviderError"
> = {
  rate_limit_exceeded: "RateLimitError",
  insufficient_quota: "QuotaExhaustedError",
  invalid_api_key: "AuthenticationError",
  server_error: "InternalProviderError",
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
 * The stored secret as the credentials its kind says it is. Keys that do not
 * parse are none: the provider then refuses, rather than a key being guessed.
 */
const credentialsOf = (provider: ProviderWithKey): Credentials | null => {
  if (!provider.apiKey) return null;
  if (effectiveSettings(getPreset(provider.preset), provider.settings).auth !== "aws")
    return { kind: "key", key: provider.apiKey };
  const keys = decodeAwsKeys(Redacted.value(provider.apiKey));
  return keys
    ? { kind: "aws", accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey }
    : null;
};

/** The package's view of a stored provider: its preset, endpoint, credentials and overrides. */
const connectionOf = (provider: ProviderWithKey): Connection | null =>
  makeConnection({
    provider: provider.id,
    preset: provider.preset,
    baseUrl: provider.baseUrl,
    credentials: credentialsOf(provider),
    settings: provider.settings,
  });

/** A stored provider as a connection, or ModelNotFound when it cannot be reached at all. */
const connect = (provider: ProviderWithKey, notFound: string) => {
  const connection = connectionOf(provider);
  return connection ? Effect.succeed(connection) : new ModelNotFound({ modelId: notFound });
};

// Separate from the stored-model lookup so a model can be tried before it is saved.
const buildModelLayer = (
  connection: Connection,
  model: {
    providerId: string;
    modelKey: string;
    capabilities: ModelCapabilities;
    format?: ModelFormat | null;
  },
  config: {
    maxOutputTokens?: number;
    reasoningEffort?: ReasoningEffort | null;
    cacheKey?: string;
    /** Runs when the model refused Responses and the call moved to Chat Completions. */
    onChatFallback?: Effect.Effect<void>;
  } = {},
  imageOutput = false,
) => {
  const actualImageOutput =
    imageOutput &&
    model.capabilities.imageOutput === true &&
    connection.preset.imageOutput &&
    connection.settings.format === "chat-completions";
  const adapter = modelClientLayer(connection, {
    model: model.modelKey,
    capabilities: model.capabilities,
    maxOutputTokens: config.maxOutputTokens,
    reasoningEffort: config.reasoningEffort,
    cacheKey: config.cacheKey,
    imageOutput: actualImageOutput,
    format: model.format,
    onChatFallback: config.onChatFallback,
  }).pipe(Layer.provide(FetchHttpClient.layer));
  // `capabilities.tools` means native tool calling. Without it the Hermes
  // polyfill sits between the adapter and the toolkit loop.
  return {
    providerId: model.providerId,
    layer: model.capabilities.tools ? adapter : withHermesTools(adapter),
    imageOutput: actualImageOutput,
  };
};

type SideGeneration = { text: string; usage: Response.Usage; finishMetadata: unknown };

/** Folds a tool-free model turn into its text, usage and finish metadata. */
const collectSideGeneration = (stream: Stream.Stream<ChatStreamPart, unknown, never>) =>
  Stream.runFoldEffect(
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
          return Effect.succeed({ ...acc, usage: part.usage, finishMetadata: part.metadata });
        // Same treatment as the streaming path: the provider's own
        // payload, classified like any other transport failure.
        case "error":
          return Effect.fail(part.error);
        default:
          return Effect.succeed(acc);
      }
    },
  );

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
  const namedError = Schema.decodeUnknownOption(StreamedErrorCode)(cause);
  return new ProviderUnreachable({
    providerId,
    message,
    ...(reason
      ? { diagnostic: { kind: reason._tag, ...(status === undefined ? {} : { status }) } }
      : Option.isSome(streamedError)
        ? { diagnostic: { kind: "ProviderStreamError", code: streamedError.value.code } }
        : Option.isSome(namedError)
          ? {
              diagnostic: {
                kind: RESPONSES_ERROR_KINDS[namedError.value.code] ?? "ProviderStreamError",
              },
            }
          : {}),
  });
};

const requestError = (providerId: string, prompt: Prompt.Prompt, imageOutput = false) => {
  const sensitive = imageOutput || isSensitivePrompt(prompt);
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
     * loop by feeding the parts back in as prompt history. A `oneOf` choice
     * advertises only those tools; the toolkit still runs a call to any of its
     * tools, so a deferred tool works before its schema is shown.
     */
    streamChat(input: {
      imageOutput?: boolean;
      reasoningEffort?: ReasoningEffort | null;
      modelId: string;
      prompt: Prompt.Prompt;
      toolkit?: Toolkit.WithHandler<any>;
      toolChoice?: ChatToolChoice;
      maxOutputTokens?: number;
      /** Groups requests that share a prompt prefix, for provider cache routing. */
      cacheKey?: string;
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
      /** OCR consent, checked against the connection used for this request. */
      expectedConnection?: ScanModelConnection;
      /** Bounds the side generation; omitted leaves the provider default. */
      maxOutputTokens?: number;
      /**
       * A chat's own request settings, so a side generation over that chat's
       * prompt reads its cached prefix: the same tools and choice are sent,
       * but no call the model makes is ever run.
       */
      sameAs?: SideGenerationRequest;
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
     * Sends one short input to `POST /embeddings` for a model that may not be
     * stored yet, and returns the vector width the provider actually produced.
     * Catalogs do not state dimensions (verified against OpenRouter), so this
     * is the only honest source. One tiny billable request; admin-only.
     */
    probeEmbeddingDimensions(input: {
      providerId: string;
      modelKey: string;
    }): Effect.Effect<{ dimensions: number }, ProviderUnreachable | ModelNotFound>;
    /** Asks a model that may not be saved yet for one short reply. */
    probeChatModel(input: {
      providerId: string;
      modelKey: string;
      format?: ModelFormat | null;
    }): Effect.Effect<
      /** `format` is the API that answered, where each model has its own. */
      { reply: string; format?: ModelFormat },
      ProviderUnreachable | ProviderContextOverflow | ModelNotFound
    >;
    /**
     * Embeds a batch of inputs with a stored embedding model through
     * `POST /embeddings`, authenticated as the preset says. The queueing,
     * validation and accounting stay here. Callers batch and bound the inputs.
     */
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

      const decodeEmbeddings = Schema.decodeUnknownEffect(EmbeddingsResponse);

      const fetchCatalog = Effect.fn("AiGateway.fetchCatalog")(function* (providerId: string) {
        const provider = yield* repo.getProviderWithKey(providerId);
        if (!provider) return yield* new ModelNotFound({ modelId: providerId });
        const connection = yield* connect(provider, providerId);
        // The preset knows its listing: OpenRouter's two, Azure's deployments, or one.
        const models = yield* Catalog.fetchCatalog(connection).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(
            (cause) =>
              new ProviderUnreachable({ providerId, message: providerErrorMessage(cause) }),
          ),
        );
        return models satisfies ReadonlyArray<CatalogModel>;
      });

      // Streaming and one-shot must not drift apart on credentials, base url
      // or model key, so both resolve the provider layer through here.
      const resolveModel = Effect.fn("AiGateway.resolveModel")(function* (
        modelId: string,
        config?: {
          maxOutputTokens?: number;
          reasoningEffort?: ReasoningEffort | null;
          cacheKey?: string;
          expectedConnection?: ScanModelConnection;
        },
        imageOutput = false,
      ) {
        const model = yield* repo.getModel(modelId);
        if (!model) return yield* new ModelNotFound({ modelId });
        const provider = yield* repo.getProviderWithKey(model.providerId);
        if (!provider) return yield* new ModelNotFound({ modelId });
        const approved = config?.expectedConnection;
        // Check the rows used below, not a preflight followed by another mutable lookup.
        if (
          approved &&
          (!model.enabled ||
            !provider.enabled ||
            model.type !== "chat" ||
            model.access !== "public" ||
            !model.capabilities.vision ||
            approved.providerId !== provider.id ||
            approved.baseUrl !== provider.baseUrl.replace(/\/$/, "") ||
            approved.modelKey !== model.modelKey)
        )
          return yield* new ProviderUnreachable({
            providerId: provider.id,
            message: "the OCR model connection changed; approval required",
            diagnostic: { kind: "InvalidRequestError" },
          });
        const connection = yield* connect(provider, modelId);
        // Stored, so the next call starts there and the admin sees the switch.
        const onChatFallback = Effect.suspend(() =>
          repo.setModelFormat(model.id, "chat-completions"),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not record a model's API", { modelId, cause }),
          ),
        );
        return buildModelLayer(connection, model, { ...config, onChatFallback }, imageOutput);
      });

      const streamChat = (input: {
        modelId: string;
        prompt: Prompt.Prompt;
        toolkit?: Toolkit.WithHandler<any>;
        toolChoice?: ChatToolChoice;
        maxOutputTokens?: number;
        cacheKey?: string;
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
            } = yield* resolveModel(
              input.modelId,
              {
                ...(input.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: input.maxOutputTokens }),
                ...(input.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: input.reasoningEffort }),
                ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
              },
              input.imageOutput === true,
            );
            const prompt = input.prompt;

            const parts = input.toolkit
              ? LanguageModel.streamText({
                  prompt,
                  toolkit: input.toolkit,
                  toolChoice: input.toolChoice ?? "auto",
                })
              : LanguageModel.streamText({ prompt });

            const provided = parts.pipe(
              Stream.provide(modelLayer),
              Stream.provideService(
                HermesCallableTools,
                new Set(input.toolkit ? Object.keys(input.toolkit.tools) : []),
              ),
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

      // Folded from the streaming endpoint, not `LanguageModel.generateText`:
      // its response schema requires `system_fingerprint`, which plain
      // OpenAI-compatible servers omit, so one-shot decode fails where
      // streaming works. Titles and compaction summaries must not require
      // OpenRouter specifically, so they ride the wire format every
      // generation already proves.
      const generateText = Effect.fn("AiGateway.generateText")(function* (input: {
        modelId: string;
        prompt: Prompt.Prompt;
        expectedConnection?: ScanModelConnection;
        maxOutputTokens?: number;
        sameAs?: SideGenerationRequest;
      }) {
        const same = input.sameAs;
        const { providerId, layer: modelLayer } = yield* resolveModel(input.modelId, {
          ...(input.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: input.maxOutputTokens }),
          ...(same?.reasoningEffort === undefined ? {} : { reasoningEffort: same.reasoningEffort }),
          ...(same?.cacheKey === undefined ? {} : { cacheKey: same.cacheKey }),
          ...(input.expectedConnection === undefined
            ? {}
            : { expectedConnection: input.expectedConnection }),
        });
        const prompt = input.prompt;
        // Without a toolkit the request carries no tools. With one, its calls
        // are never resolved: only text is wanted.
        const stream = (
          same?.toolkit
            ? LanguageModel.streamText({
                prompt,
                toolkit: same.toolkit,
                toolChoice: same.toolChoice ?? "auto",
                disableToolCallResolution: true,
              })
            : LanguageModel.streamText({ prompt })
        ).pipe(
          Stream.provide(modelLayer),
          Stream.provideService(
            HermesCallableTools,
            new Set(same?.toolkit ? Object.keys(same.toolkit.tools) : []),
          ),
          // As in `streamChat`: the executor already provided the handlers,
          // and none of them runs here anyway.
        ) as Stream.Stream<ChatStreamPart, unknown, never>;

        return yield* collectSideGeneration(stream).pipe(
          Effect.mapError(requestError(providerId, input.prompt)),
        );
      });

      /**
       * One short request to a model that may not be saved yet, so an admin can
       * see the provider answers for that model ID before adding it. One tiny
       * billable request; admin-only.
       */
      const probeChatModel = Effect.fn("AiGateway.probeChatModel")(function* (input: {
        providerId: string;
        modelKey: string;
        format?: ModelFormat | null;
      }) {
        const provider = yield* repo.getProviderWithKey(input.providerId);
        if (!provider?.enabled) return yield* new ModelNotFound({ modelId: input.providerId });
        const modelKey = input.modelKey.trim();
        if (!modelKey || modelKey.length > 200)
          return yield* new ProviderUnreachable({
            providerId: provider.id,
            message: "invalid model key",
            diagnostic: { kind: "InvalidRequestError" },
          });
        const connection = yield* connect(provider, input.providerId);
        let fellBack = false;
        // Room for a reasoning model to think before it says OK.
        const { layer } = buildModelLayer(
          connection,
          {
            providerId: provider.id,
            modelKey,
            capabilities: { ...EMPTY_CAPABILITIES, tools: true },
            format: input.format ?? null,
          },
          { maxOutputTokens: 512, onChatFallback: Effect.sync(() => void (fellBack = true)) },
        );
        const prompt = Prompt.make("Reply with the single word OK.");
        const stream = LanguageModel.streamText({ prompt }).pipe(
          Stream.provide(layer),
          Stream.provideService(HermesCallableTools, new Set<string>()),
        ) as Stream.Stream<ChatStreamPart, unknown, never>;
        const result = yield* collectSideGeneration(stream).pipe(
          Effect.timeout(Duration.seconds(60)),
          Effect.mapError(requestError(provider.id, prompt)),
        );
        const used = fellBack
          ? "chat-completions"
          : formatFor(connection.preset, connection.settings, modelKey, input.format);
        return {
          reply: result.text.trim().slice(0, 200),
          // Only where the model's API is its own choice, for the dialog to show it.
          ...(connection.preset.modelFormat && used !== "messages" ? { format: used } : {}),
        };
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
          const connection = yield* connect(provider, input.providerId);
          const response = yield* jsonRequest(connection, endpoint(connection, "/embeddings"), {
            model: modelKey,
            input: ["dimension probe"],
          }).pipe(
            Effect.flatMap((request) => httpClient.execute(request)),
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
            approved.baseUrl !== provider.baseUrl.replace(/\/+$/, "") ||
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
        const connection = yield* connect(provider, input.modelId);
        const request = yield* jsonRequest(connection, endpoint(connection, "/embeddings"), {
          model: model.modelKey,
          input: input.inputs,
        }).pipe(
          Effect.mapError(
            (error) => new ProviderUnreachable({ providerId, message: error.message }),
          ),
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
                if (res.status < 200 || res.status >= 300) {
                  // The provider's own words go to the server log only: bodies
                  // may echo inputs, so they never reach a stored error.
                  const body = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
                  const said = Option.getOrUndefined(
                    Schema.decodeUnknownOption(ProviderErrorBody)(safeJson(body)),
                  )?.error.message;
                  yield* Effect.logWarning("embedding request refused", {
                    providerId,
                    status: res.status,
                    ...(said ? { detail: said.slice(0, 300) } : {}),
                  });
                  return yield* Effect.fail(
                    new ProviderUnreachable({
                      providerId,
                      message:
                        res.status === 429
                          ? "the embedding provider is rate limiting requests"
                          : `the embedding provider answered ${res.status}`,
                      diagnostic: embeddingDiagnostic(res.status, res.headers["retry-after"]),
                    }),
                  );
                }
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
            // An HTTP status already classified above keeps its diagnosis.
            Effect.mapError((error) =>
              error instanceof ProviderUnreachable
                ? error
                : new ProviderUnreachable({
                    providerId,
                    message: "embedding request failed or timed out",
                    diagnostic: { kind: "NetworkError" },
                  }),
            ),
          );

          // Malformed or mismatched output is a contract failure of the model,
          // not provider weather: retrying the same request cannot change the
          // vector width it returns, so the job must settle as failed at once.
          // oxlint-disable-next-line unicorn/consistent-function-scoping -- reads providerId from the enclosing job
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
                cacheWriteTokens: null,
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
        probeChatModel,
        streamChat,
        generateText,
        // Shared by indexing and query requests, not one semaphore per caller.
        embed: (input) => embeddingPermits.withPermits(1)(embed(input)),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
