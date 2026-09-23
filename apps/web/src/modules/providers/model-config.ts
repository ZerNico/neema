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
export type ReasoningEffortFormat = "unsupported" | "flat" | "nested";

export const actionableReasoningEfforts = (
  capabilities: ModelCapabilities,
  providerKind: "openrouter" | "openai-compatible",
  format: ReasoningEffortFormat,
): ReasoningEffort[] =>
  capabilities.reasoning && (providerKind === "openrouter" || format !== "unsupported")
    ? [...(capabilities.reasoningEfforts ?? [])]
    : [];

export interface ModelCapabilities {
  /** Native image output; absent on older model records means disabled. */
  imageOutput?: boolean;
  reasoning: boolean;
  reasoningEfforts?: ReadonlyArray<ReasoningEffort>;
  tools: boolean;
  vision: boolean;
  files: boolean;
}

export type ModelPricing = { input: number; output: number } | { input: number; output: null };

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
    imageOutput?: false;
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
