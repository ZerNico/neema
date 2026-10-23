import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { authenticate, endpoint, type Connection } from "./connection.ts";
import { httpError, invalidOutput, networkError } from "./errors.ts";
import { inferImageFamily, type ImageFamily } from "./images/families.ts";
import { getPreset, PRESET_IDS } from "./preset.ts";
import { bedrockScope } from "./sigv4.ts";

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

/**
 * An image model's prices as the catalog states them: USD per 1M tokens, and a
 * flat USD fee per reference image where the model charges one.
 */
export interface CatalogImagePricing {
  readonly tokens: {
    readonly textInput: number;
    readonly imageInput: number;
    readonly output: number;
  };
  readonly perReference?: number;
}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly type: "chat" | "embedding" | "image";
  readonly contextLength: number | null;
  readonly capabilities: CatalogCapabilities;
  readonly pricing: CatalogPricing | null;
  /** The image family an `image` entry is called with. */
  readonly imageFamily?: ImageFamily;
  readonly imagePricing?: CatalogImagePricing | null;
}

const NO_CAPABILITIES: CatalogCapabilities = {
  reasoning: false,
  tools: false,
  vision: false,
  files: false,
  imageOutput: false,
};

const imageEntry = (
  id: string,
  name: string,
  family: ImageFamily,
  imagePricing: CatalogImagePricing | null = null,
): CatalogModel => ({
  id,
  name,
  type: "image",
  contextLength: null,
  capabilities: NO_CAPABILITIES,
  // Chat token prices; an image model's own go in `imagePricing`.
  pricing: null,
  imageFamily: family,
  imagePricing,
});

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
 * OpenRouter's image prices: `prompt` per text token, `image_output` per image
 * token drawn. `image` is ambiguous. Beside `image_token` (FLUX, Grok, Qwen) it
 * is a flat fee per reference image; without it (Gemini) it is the per-token
 * price of an image read, the same scale as `prompt`.
 */
export const catalogImagePricing = (pricing: unknown): CatalogImagePricing | null => {
  if (!isRecord(pricing)) return null;
  const perMillion = (key: string) => {
    const value = perToken(pricing[key]);
    return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : undefined;
  };
  const output = perMillion("image_output") ?? perMillion("completion");
  if (output === undefined) return null;
  const textInput = perMillion("prompt") ?? 0;
  const perImageToken = perMillion("image_token");
  const image = perToken(pricing["image"]);
  const fee = Number.isFinite(image) && image > 0 ? image : undefined;
  return {
    tokens: {
      textInput,
      imageInput: perImageToken ?? (fee === undefined ? textInput : fee * 1_000_000),
      output,
    },
    ...(perImageToken !== undefined && fee !== undefined ? { perReference: fee } : {}),
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

/**
 * An image model in a plain listing: by the listing's own `type` where it has
 * one (Vercel), else by the id. OpenRouter lists image models separately.
 */
const listedImage = (connection: Connection, raw: Record<string, unknown>, id: string) => {
  if (connection.preset.catalog === "openrouter") return null;
  const preset = PRESET_IDS.find((presetId) => presetId === connection.preset.id);
  if (!preset) return null;
  if (typeof raw["type"] === "string" && raw["type"] !== "image") return null;
  const family = inferImageFamily(preset, id);
  if (raw["type"] === "image")
    return (
      family ??
      (getPreset(preset).images?.families.includes("openai-compatible-image")
        ? "openai-compatible-image"
        : null)
    );
  return family;
};

const listingEntry = (
  connection: Connection,
  raw: unknown,
  efforts: boolean,
): CatalogModel | null => {
  if (!isRecord(raw) || typeof raw["id"] !== "string") return null;
  const family = listedImage(connection, raw, raw["id"]);
  if (family)
    return imageEntry(raw["id"], typeof raw["name"] === "string" ? raw["name"] : raw["id"], family);
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
    const headers = yield* authenticate(connection, { method: "GET", url, body: "" });
    const response = yield* http
      .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)))
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
  // Classified by the base model; requests name the deployment.
  const family = inferImageFamily("azure", model);
  if (family)
    return imageEntry(raw["id"], raw["id"] === model ? model : `${raw["id"]} (${model})`, family);
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
 * Bedrock's Claude as its inference profiles (`eu.anthropic.…`), the IDs the
 * Messages route takes. Mantle's listing has no Claude at all.
 */
const bedrockProfile =
  (connection: Connection) =>
  (raw: unknown): CatalogModel | null => {
    if (!isRecord(raw) || typeof raw["inferenceProfileId"] !== "string") return null;
    const id = raw["inferenceProfileId"];
    if (raw["status"] !== undefined && raw["status"] !== "ACTIVE") return null;
    if (connection.preset.messages?.models.test(id) !== true) return null;
    return {
      id,
      name: typeof raw["inferenceProfileName"] === "string" ? raw["inferenceProfileName"] : id,
      type: "chat",
      contextLength: null,
      capabilities: {
        imageOutput: false,
        reasoning: false,
        tools: true,
        vision: true,
        files: true,
      },
      pricing: null,
    };
  };

/** Bedrock's image foundation models that run on demand, by their family. */
const bedrockImage = (raw: unknown): CatalogModel | null => {
  if (!isRecord(raw) || typeof raw["modelId"] !== "string") return null;
  const lifecycle = isRecord(raw["modelLifecycle"]) ? raw["modelLifecycle"]["status"] : undefined;
  if (lifecycle !== undefined && lifecycle !== "ACTIVE") return null;
  const inference = strings(raw["inferenceTypesSupported"]);
  if (inference && !inference.includes("ON_DEMAND")) return null;
  const family = inferImageFamily("bedrock", raw["modelId"]);
  if (!family) return null;
  return imageEntry(
    raw["modelId"],
    typeof raw["modelName"] === "string" ? raw["modelName"] : raw["modelId"],
    family,
  );
};

/**
 * OpenRouter's image models as image entries. One that also chats is listed
 * twice under the same id, once per type, the image entry beside its chat one.
 */
const withOpenRouterImages = (
  listed: ReadonlyArray<CatalogModel>,
  images: ReadonlyArray<unknown>,
  priced: ReadonlyArray<unknown>,
): ReadonlyArray<CatalogModel> => {
  // The image listing carries no prices; the main one, asked for image output, does.
  const prices = new Map(
    priced.flatMap((raw) =>
      isRecord(raw) && typeof raw["id"] === "string"
        ? [[raw["id"], catalogImagePricing(raw["pricing"])] as const]
        : [],
    ),
  );
  const names = new Map(
    images.flatMap((raw) =>
      isRecord(raw) && typeof raw["id"] === "string"
        ? [[raw["id"], typeof raw["name"] === "string" ? raw["name"] : raw["id"]] as const]
        : [],
    ),
  );
  const known = new Set(listed.map((model) => model.id));
  return [
    ...listed.flatMap((model) => {
      const name = names.get(model.id);
      return name !== undefined && model.type === "chat"
        ? [model, imageEntry(model.id, name, "openrouter-image", prices.get(model.id) ?? null)]
        : [model];
    }),
    ...Array.from(names)
      .filter(([id]) => !known.has(id))
      .map(([id, name]) => imageEntry(id, name, "openrouter-image", prices.get(id) ?? null)),
  ];
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
      case "bedrock": {
        const listed = listing(yield* getJson(connection, endpoint(connection, "/models"))).flatMap(
          (raw) => listingEntry(connection, raw, false) ?? [],
        );
        const scope = bedrockScope(new URL(connection.baseUrl));
        if (!scope) return listed;
        // Mantle lists no image models; the control plane does, under its own permission.
        const images = yield* getJson(
          connection,
          `https://bedrock.${scope.region}.amazonaws.com/foundation-models?byOutputModality=IMAGE`,
        ).pipe(
          Effect.map((value) =>
            isRecord(value) && Array.isArray(value["modelSummaries"])
              ? value["modelSummaries"].flatMap((raw) => bedrockImage(raw) ?? [])
              : [],
          ),
          Effect.orElseSucceed((): CatalogModel[] => []),
        );
        // Listing profiles is its own IAM permission; without it the rest still shows.
        const profiles = yield* getJson(
          connection,
          `https://bedrock.${scope.region}.amazonaws.com/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000`,
        ).pipe(
          Effect.map((value) =>
            isRecord(value) && Array.isArray(value["inferenceProfileSummaries"])
              ? value["inferenceProfileSummaries"].flatMap(
                  (raw) => bedrockProfile(connection)(raw) ?? [],
                )
              : [],
          ),
          Effect.orElseSucceed((): CatalogModel[] => []),
        );
        return [...listed, ...profiles, ...images];
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
        const listed = pages
          .flatMap(listing)
          .flatMap(
            (raw) =>
              listingEntry(connection, raw, connection.preset.catalog === "openrouter") ?? [],
          )
          .filter((model) => !seen.has(model.id) && Boolean(seen.add(model.id)));
        if (connection.preset.catalog !== "openrouter") return listed;
        // Listings of their own; without them the chat models still show.
        const [images, priced] = yield* Effect.all(
          [
            endpoint(connection, "/images/models"),
            endpoint(connection, "/models?output_modalities=image"),
          ].map((url) =>
            getJson(connection, url).pipe(
              Effect.map(listing),
              Effect.orElseSucceed((): unknown[] => []),
            ),
          ),
          { concurrency: 2 },
        );
        return withOpenRouterImages(listed, images ?? [], priced ?? []);
      }
    }
  });
