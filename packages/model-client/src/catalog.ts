import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { authHeaders, endpoint, type Connection } from "./connection.ts";
import { httpError, invalidOutput, networkError } from "./errors.ts";

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CatalogCapabilities {
  readonly reasoning: boolean;
  readonly tools: boolean;
  readonly vision: boolean;
  readonly files: boolean;
  readonly imageOutput: boolean;
  readonly reasoningEfforts?: ReadonlyArray<ReasoningEffort>;
}

/** USD per 1M tokens. Cache rates only where the catalog states them. */
export interface CatalogPricing {
  readonly input: number;
  readonly output: number | null;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly type: "chat" | "embedding";
  readonly contextLength: number | null;
  readonly capabilities: CatalogCapabilities;
  readonly pricing: CatalogPricing | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const strings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

const perToken = (value: unknown) =>
  typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : typeof value === "number"
      ? value
      : Number.NaN;

/**
 * Catalog prices arrive as USD per token ("0.0000025"); the app stores USD
 * per 1M tokens. A free model ("0") is a zero price, a statement, not unknown.
 */
export const catalogPricing = (pricing: unknown): CatalogPricing | null => {
  if (!isRecord(pricing)) return null;
  // OpenRouter: prompt/completion/input_cache_*; Vercel: input/output/input_cache_*.
  const input = perToken(pricing["prompt"] ?? pricing["input"]);
  const output = perToken(pricing["completion"] ?? pricing["output"]);
  const cacheRead = perToken(pricing["input_cache_read"]);
  const cacheWrite = perToken(pricing["input_cache_write"]);
  if (!Number.isFinite(input)) return null;
  return {
    input: input * 1_000_000,
    output: Number.isFinite(output) ? output * 1_000_000 : null,
    ...(Number.isFinite(cacheRead) ? { cacheRead: cacheRead * 1_000_000 } : {}),
    ...(Number.isFinite(cacheWrite) ? { cacheWrite: cacheWrite * 1_000_000 } : {}),
  };
};

/**
 * OpenRouter lists embedding models with `output_modalities: ["embeddings"]`;
 * plain catalogs omit the field, and the admin sets the type by hand.
 * Image, audio and video generation, reranking and speech are out of scope.
 */
export const inferType = (outputModalities: ReadonlyArray<string> | undefined) => {
  if (!outputModalities) return "chat" as const;
  if (outputModalities.includes("text")) return "chat" as const;
  if (outputModalities.includes("embeddings") || outputModalities.includes("embedding"))
    return "embedding" as const;
  return null;
};

const listingEntry = (raw: unknown, efforts: boolean): CatalogModel | null => {
  if (!isRecord(raw) || typeof raw["id"] !== "string") return null;
  const architecture = isRecord(raw["architecture"]) ? raw["architecture"] : {};
  const output = strings(architecture["output_modalities"]) ?? strings(raw["output_modalities"]);
  const input = strings(architecture["input_modalities"]) ?? strings(raw["input_modalities"]) ?? [];
  const type = raw["type"] === "embedding" ? "embedding" : inferType(output);
  if (type === null) return null;
  const params = strings(raw["supported_parameters"]) ?? [];
  const tags = strings(raw["tags"]) ?? [];
  const supported = isRecord(raw["reasoning"])
    ? strings(raw["reasoning"]["supported_efforts"])
    : undefined;
  const reasoning =
    params.includes("reasoning") ||
    params.includes("include_reasoning") ||
    tags.includes("reasoning") ||
    (efforts && (supported?.length ?? 0) > 0);
  const contextLength = raw["context_length"] ?? raw["context_window"];
  return {
    id: raw["id"],
    name: typeof raw["name"] === "string" ? raw["name"] : raw["id"],
    type,
    contextLength: typeof contextLength === "number" ? contextLength : null,
    capabilities: {
      imageOutput: output?.includes("image") === true,
      reasoning,
      tools: params.includes("tools") || tags.includes("tool-use"),
      vision: input.includes("image") || tags.includes("vision"),
      files: input.includes("file"),
      ...(efforts && type === "chat" && supported
        ? { reasoningEfforts: REASONING_EFFORTS.filter((effort) => supported.includes(effort)) }
        : {}),
    },
    pricing: catalogPricing(raw["pricing"]),
  };
};

const getJson = (connection: Connection, url: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(authHeaders(connection))),
      )
      .pipe(Effect.mapError(() => networkError("The provider could not be reached")));
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.fail(
        httpError({ method: "GET", status: response.status, headers: {}, body, url }),
      );
    }
    return yield* response.json.pipe(
      Effect.mapError(() => invalidOutput("The provider's model list is not JSON")),
    );
  });

const listing = (value: unknown) =>
  isRecord(value) && Array.isArray(value["data"])
    ? value["data"]
    : Array.isArray(value)
      ? value
      : [];

/** Azure deployments run a base model under a name of the admin's choosing. */
const AZURE_SKIPPED = /dall-e|whisper|tts|sora|realtime|transcribe|audio|document-ai|image/i;

const azureEntry = (raw: unknown): CatalogModel | null => {
  if (!isRecord(raw) || typeof raw["id"] !== "string" || typeof raw["model"] !== "string")
    return null;
  if (raw["status"] !== undefined && raw["status"] !== "succeeded") return null;
  const model = raw["model"];
  if (AZURE_SKIPPED.test(model)) return null;
  const embedding = /embedding/i.test(model);
  const reasoning = /^(o\d|gpt-5)/i.test(model);
  return {
    id: raw["id"],
    name: raw["id"] === model ? model : `${raw["id"]} (${model})`,
    type: embedding ? "embedding" : "chat",
    contextLength: null,
    capabilities: {
      imageOutput: false,
      reasoning: !embedding && reasoning,
      tools: !embedding && /^(gpt|o\d)/i.test(model),
      vision: !embedding && /^(gpt-4o|gpt-4\.1|gpt-5|o3|o4)/i.test(model),
      files: false,
    },
    pricing: null,
  };
};

/**
 * The models a connection offers, per its preset: OpenRouter's two listings
 * (text and embeddings), Azure's deployments, or one OpenAI-style listing.
 */
export const fetchCatalog = (connection: Connection) =>
  Effect.gen(function* () {
    switch (connection.preset.catalog) {
      case "none":
        return [];
      case "azure-deployments": {
        // The v1 `/models` lists the region's base models, not the deployments
        // requests name; the older data-plane listing has the deployments.
        const root = connection.baseUrl.replace(/\/openai\/v1$/, "");
        const value = yield* getJson(
          connection,
          `${root}/openai/deployments?api-version=2022-12-01`,
        );
        return listing(value).flatMap((raw) => azureEntry(raw) ?? []);
      }
      case "openrouter":
      case "openai-list": {
        const urls =
          connection.preset.catalog === "openrouter"
            ? [
                endpoint(connection, "/models"),
                endpoint(connection, "/models?output_modalities=embeddings"),
              ]
            : [endpoint(connection, "/models")];
        const pages = yield* Effect.all(
          urls.map((url) => getJson(connection, url)),
          { concurrency: 2 },
        );
        const seen = new Set<string>();
        return pages
          .flatMap(listing)
          .flatMap((raw) => listingEntry(raw, connection.preset.catalog === "openrouter") ?? [])
          .filter((model) => !seen.has(model.id) && Boolean(seen.add(model.id)));
      }
    }
  });
