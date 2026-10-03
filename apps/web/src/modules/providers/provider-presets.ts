export const PROVIDER_PRESETS = {
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  "openai-compatible": { label: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1" },
} as const;

export type ProviderKind = keyof typeof PROVIDER_PRESETS;

/** A blank base URL means the kind's default, resolved at write time so the row stays concrete. */
export const resolveBaseUrl = (kind: ProviderKind, baseUrl: string | undefined) =>
  baseUrl?.trim() || PROVIDER_PRESETS[kind].baseUrl;
