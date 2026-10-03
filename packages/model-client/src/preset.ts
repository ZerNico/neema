/**
 * A preset is everything that differs between services speaking an OpenAI-like
 * API, as data: where they live, how they authenticate, which request fields
 * they accept and which response fields they fill. The codecs read it; they
 * never branch on a service's name.
 */

export const WIRE_FORMATS = ["chat-completions", "responses"] as const;
export type WireFormat = (typeof WIRE_FORMATS)[number];

/**
 * How a reasoning level goes out on Chat Completions. Responses always nests
 * it. Strict servers refuse fields they do not know, so a preset sends exactly
 * one shape or none.
 */
export const REASONING_SHAPES = [
  "none",
  /** `reasoning_effort: "high"` (OpenAI, Groq, Gemini, most others). */
  "flat",
  /** `reasoning: { effort: "high" }` (OpenRouter, Vercel). */
  "nested",
] as const;
export type ReasoningShape = (typeof REASONING_SHAPES)[number];

export type MaxTokensField = "max_tokens" | "max_completion_tokens";
export type CacheKeyField = "none" | "prompt_cache_key" | "session_id";
export type Catalog = "openrouter" | "openai-list" | "azure-deployments" | "none";

/** What an admin may change on a provider; the rest is the preset's. */
export interface ProviderSettings {
  readonly format?: WireFormat;
  readonly reasoning?: ReasoningShape;
  /**
   * Sends a model's reasoning back on its next tool round, in the field the
   * server used: `reasoning_details` or `reasoning_content`. Never the plain
   * `reasoning` field, which Groq rejects.
   */
  readonly sendReasoning?: boolean;
  readonly streamUsage?: boolean;
  /** Header the key goes in instead of `Authorization: Bearer` (`api-key`, `x-api-key`). */
  readonly keyHeader?: string;
}
export type SettingKey = keyof ProviderSettings;

/** Settings with every choice made, as a request reads them. */
export interface ResolvedSettings {
  readonly format: WireFormat;
  readonly reasoning: ReasoningShape;
  readonly sendReasoning: boolean;
  /** Fixed per preset: only OpenAI and OpenRouter route by a cache key. */
  readonly cacheKey: CacheKeyField;
  /** Fixed per preset: OpenAI's reasoning models refuse `max_tokens`. */
  readonly maxTokensField: MaxTokensField;
  readonly streamUsage: boolean;
  readonly keyHeader?: string;
}

export interface Preset {
  readonly id: string;
  readonly label: string;
  /** Null when there is no shared endpoint and the admin must enter one. */
  readonly baseUrl: string | null;
  readonly baseUrlPlaceholder?: string;
  /** Rewrites what an admin typed into the URL requests go to (Azure's `/openai/v1`). */
  readonly normalizeBaseUrl?: (url: string) => string;
  /** Whether a key is required; self-hosted servers often run without one. */
  readonly keyRequired: boolean;
  readonly formats: ReadonlyArray<WireFormat>;
  readonly defaults: ResolvedSettings;
  /** Settings an admin may override on this preset. */
  readonly overridable: ReadonlyArray<SettingKey>;
  /** Only these models get explicit cache markers; everyone else caches a stable prefix by itself. */
  readonly cacheMarkers?: RegExp;
  /** OpenRouter's `modalities`, sent on every request so image output is per call. */
  readonly imageOutput: boolean;
  readonly catalog: Catalog;
  /** One line shown under the preset in admin. */
  readonly note?: string;
}

const ALL_SETTINGS: ReadonlyArray<SettingKey> = [
  "format",
  "reasoning",
  "sendReasoning",
  "streamUsage",
  "keyHeader",
];

const chat = {
  format: "chat-completions",
  reasoning: "none",
  sendReasoning: true,
  cacheKey: "none",
  maxTokensField: "max_tokens",
  streamUsage: true,
} as const satisfies Preset["defaults"];

const azureBaseUrl = (url: string) => {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/openai/v1")) return trimmed;
  // A resource or Foundry endpoint as the portal shows it.
  if (/^https:\/\/[^/]+$/.test(trimmed)) return `${trimmed}/openai/v1`;
  return trimmed;
};

const definePresets = <const T extends ReadonlyArray<Preset>>(presets: T) => presets;

export const PRESETS = definePresets([
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyRequired: true,
    formats: ["chat-completions"],
    defaults: { ...chat, reasoning: "nested", cacheKey: "session_id" },
    overridable: [],
    cacheMarkers: /^anthropic\//,
    imageOutput: true,
    catalog: "openrouter",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyRequired: true,
    formats: ["responses", "chat-completions"],
    defaults: {
      ...chat,
      format: "responses",
      reasoning: "flat",
      cacheKey: "prompt_cache_key",
      maxTokensField: "max_completion_tokens",
    },
    overridable: ["format"],
    imageOutput: false,
    catalog: "openai-list",
  },
  {
    id: "azure",
    label: "Azure",
    baseUrl: null,
    baseUrlPlaceholder: "https://your-resource.openai.azure.com",
    normalizeBaseUrl: azureBaseUrl,
    keyRequired: true,
    formats: ["responses", "chat-completions"],
    defaults: {
      ...chat,
      format: "responses",
      reasoning: "flat",
      maxTokensField: "max_completion_tokens",
      keyHeader: "api-key",
    },
    overridable: ["format"],
    imageOutput: false,
    catalog: "azure-deployments",
    note: "Models are deployment names",
  },
  {
    id: "vercel",
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    keyRequired: true,
    formats: ["chat-completions"],
    defaults: { ...chat, reasoning: "nested" },
    overridable: [],
    cacheMarkers: /^anthropic\//,
    imageOutput: false,
    catalog: "openai-list",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyRequired: true,
    formats: ["chat-completions"],
    defaults: { ...chat, reasoning: "flat" },
    overridable: [],
    imageOutput: false,
    catalog: "openai-list",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyRequired: true,
    formats: ["chat-completions"],
    defaults: chat,
    overridable: [],
    imageOutput: false,
    catalog: "openai-list",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyRequired: true,
    formats: ["chat-completions"],
    // Mistral rejects `stream_options`; usage arrives regardless.
    defaults: { ...chat, streamUsage: false },
    overridable: [],
    imageOutput: false,
    catalog: "openai-list",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyRequired: true,
    formats: ["chat-completions"],
    defaults: { ...chat, reasoning: "flat", maxTokensField: "max_completion_tokens" },
    overridable: [],
    imageOutput: false,
    catalog: "openai-list",
  },
  {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    keyRequired: true,
    formats: ["responses", "chat-completions"],
    defaults: { ...chat, format: "responses", reasoning: "flat" },
    overridable: ["format"],
    imageOutput: false,
    catalog: "openai-list",
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: null,
    baseUrlPlaceholder: "http://localhost:11434/v1",
    keyRequired: false,
    formats: ["chat-completions"],
    defaults: { ...chat, reasoning: "flat" },
    overridable: ["reasoning"],
    imageOutput: false,
    catalog: "openai-list",
    note: "Ollama cuts prompts to its context size, set OLLAMA_CONTEXT_LENGTH",
  },
  {
    id: "custom",
    label: "OpenAI-compatible",
    baseUrl: null,
    baseUrlPlaceholder: "https://api.example.com/v1",
    keyRequired: false,
    formats: ["chat-completions", "responses"],
    defaults: chat,
    overridable: ALL_SETTINGS,
    imageOutput: false,
    catalog: "openai-list",
  },
]);

export type PresetId = (typeof PRESETS)[number]["id"];
export const PRESET_IDS = PRESETS.map((preset) => preset.id) as ReadonlyArray<PresetId>;

export const isPresetId = (value: string): value is PresetId =>
  (PRESET_IDS as ReadonlyArray<string>).includes(value);

export const getPreset = (id: PresetId): Preset => PRESETS.find((preset) => preset.id === id)!;

/** The effective settings: preset defaults under the admin's allowed overrides. */
export const effectiveSettings = (
  preset: Preset,
  overrides: ProviderSettings | null | undefined,
) => {
  const allowed = (key: SettingKey) => preset.overridable.includes(key);
  const pick = <K extends SettingKey>(key: K) =>
    allowed(key) && overrides?.[key] !== undefined ? overrides[key] : undefined;
  const format = pick("format");
  const keyHeader = pick("keyHeader") ?? preset.defaults.keyHeader;
  return {
    format: format && preset.formats.includes(format) ? format : preset.defaults.format,
    reasoning: pick("reasoning") ?? preset.defaults.reasoning,
    sendReasoning: pick("sendReasoning") ?? preset.defaults.sendReasoning,
    cacheKey: preset.defaults.cacheKey,
    maxTokensField: preset.defaults.maxTokensField,
    streamUsage: pick("streamUsage") ?? preset.defaults.streamUsage,
    ...(keyHeader ? { keyHeader } : {}),
  } satisfies ResolvedSettings;
};

/**
 * Keeps only overrides the preset allows and that differ from its defaults, so
 * a stored row says exactly what an admin changed.
 */
export const sanitizeSettings = (
  preset: Preset,
  overrides: ProviderSettings | null | undefined,
): ProviderSettings => {
  const kept: Record<string, unknown> = {};
  for (const key of preset.overridable) {
    const value = overrides?.[key];
    if (value === undefined || value === preset.defaults[key]) continue;
    if (key === "format" && !preset.formats.includes(value as WireFormat)) continue;
    if (key === "keyHeader" && !/^[A-Za-z0-9-]{1,64}$/.test(String(value))) continue;
    kept[key] = value;
  }
  return kept as ProviderSettings;
};

/** The URL requests go to, or null when the preset has none and none was entered. */
export const resolveBaseUrl = (preset: Preset, entered: string | null | undefined) => {
  const url = entered?.trim() || preset.baseUrl;
  if (!url) return null;
  return (preset.normalizeBaseUrl ?? ((value: string) => value.replace(/\/+$/, "")))(url);
};
