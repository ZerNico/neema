import { sendsReasoningEffort } from "./provider-presets.ts";

export const MODEL_TYPES = ["chat", "embedding"] as const;

export type ModelType = (typeof MODEL_TYPES)[number];
export type ModelAccess = "public" | "groups";

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

export const actionableReasoningEfforts = (
  capabilities: ModelCapabilities,
  provider: Parameters<typeof sendsReasoningEffort>[0],
): ReasoningEffort[] =>
  capabilities.reasoning && sendsReasoningEffort(provider)
    ? [...(capabilities.reasoningEfforts ?? [])]
    : [];

export interface ModelCapabilities {
  /** Native image output, asked for per call where the provider supports it. */
  imageOutput: boolean;
  reasoning: boolean;
  reasoningEfforts?: ReadonlyArray<ReasoningEffort>;
  tools: boolean;
  vision: boolean;
  files: boolean;
}

/**
 * USD per 1M tokens. Cache rates are optional: without them a cached read or a
 * cache write is priced as ordinary input.
 */
export type ModelPricing = ({ input: number; output: number } | { input: number; output: null }) & {
  cacheRead?: number;
  cacheWrite?: number;
};

interface CommonModelSettings {
  displayName: string;
  /** Absent leaves a stored description as it is; null clears it. */
  description?: string | null;
  contextLength: number | null;
  enabled: boolean;
  access: ModelAccess;
  groupIds: ReadonlyArray<string>;
}

export interface ChatModelSettings extends CommonModelSettings {
  type: "chat";
  embeddingDimensions: null;
  capabilities: ModelCapabilities;
  pricing: { input: number; output: number } | null;
}

export interface EmbeddingModelSettings extends CommonModelSettings {
  type: "embedding";
  embeddingDimensions: number | null;
  capabilities: {
    imageOutput: false;
    reasoning: false;
    tools: false;
    vision: boolean;
    files: false;
  };
  pricing: { input: number; output: null } | null;
}

export type ModelSettings = ChatModelSettings | EmbeddingModelSettings;

export interface UnnormalizedModelSettings extends CommonModelSettings {
  type: ModelType;
  embeddingDimensions: number | null;
  capabilities: ModelCapabilities;
  pricing: ModelPricing | null;
}

export const EMPTY_CAPABILITIES: ModelCapabilities = {
  imageOutput: false,
  reasoning: false,
  tools: false,
  vision: false,
  files: false,
};

export const normalizeModelSettings = (settings: UnnormalizedModelSettings): ModelSettings => {
  const groupIds = settings.access === "groups" ? [...new Set(settings.groupIds)] : [];

  if (settings.type === "embedding") {
    return {
      ...settings,
      type: "embedding",
      capabilities: {
        imageOutput: false,
        reasoning: false,
        tools: false,
        vision: settings.capabilities.vision,
        files: false,
      },
      pricing: settings.pricing ? { input: settings.pricing.input, output: null } : null,
      groupIds,
    };
  }

  const { reasoningEfforts: _, ...withoutEfforts } = settings.capabilities;
  return {
    ...settings,
    type: "chat",
    embeddingDimensions: null,
    capabilities: settings.capabilities.reasoning ? settings.capabilities : withoutEfforts,
    pricing: settings.pricing?.output === null ? null : settings.pricing,
    groupIds,
  };
};
