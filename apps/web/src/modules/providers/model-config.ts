import {
  effectiveImageCapabilities,
  type ImageCapabilities,
  type ImageFamily,
} from "@chat/model-client/image-families";
import { sendsReasoningEffort } from "./provider-presets.ts";

export const MODEL_TYPES = ["chat", "embedding", "image"] as const;

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
  modelKey: string,
): ReasoningEffort[] =>
  capabilities.reasoning && sendsReasoningEffort(provider, modelKey)
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

/**
 * USD for an image model. `tokens` prices an operation whose usage the API
 * reports (per 1M tokens; image input is a subset of input). `perImage` prices
 * one image by quality, `default` for any quality without its own price.
 */
export interface ImagePricing {
  readonly tokens?: {
    readonly textInput: number;
    readonly imageInput: number;
    readonly output: number;
  };
  readonly perImage?: Readonly<Partial<Record<"default" | "low" | "medium" | "high", number>>>;
}

/** The APIs a model can be called on, where its preset lets models differ (Azure). */
export const MODEL_FORMATS = ["responses", "chat-completions"] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

interface CommonModelSettings {
  displayName: string;
  /** Absent leaves a stored description as it is; null clears it. */
  description?: string | null;
  /** Absent leaves the stored API as it is; null returns to the preset's. */
  format?: ModelFormat | null;
  contextLength: number | null;
  enabled: boolean;
  access: ModelAccess;
  groupIds: ReadonlyArray<string>;
}

/** Absent on input; normalization writes the nulls, so a type change clears them. */
interface NoImageSettings {
  imageFamily?: null;
  imageCapabilities?: null;
  imagePricing?: null;
}

export interface ChatModelSettings extends CommonModelSettings, NoImageSettings {
  type: "chat";
  embeddingDimensions: null;
  capabilities: ModelCapabilities;
  pricing: { input: number; output: number } | null;
}

export interface ImageModelSettings extends CommonModelSettings {
  type: "image";
  embeddingDimensions: null;
  capabilities: ModelCapabilities;
  pricing: null;
  imageFamily: ImageFamily;
  imageCapabilities: ImageCapabilities;
  imagePricing: ImagePricing | null;
}

export interface EmbeddingModelSettings extends CommonModelSettings, NoImageSettings {
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

export type ModelSettings = ChatModelSettings | EmbeddingModelSettings | ImageModelSettings;

export interface UnnormalizedModelSettings extends CommonModelSettings {
  type: ModelType;
  embeddingDimensions: number | null;
  capabilities: ModelCapabilities;
  pricing: ModelPricing | null;
  imageFamily?: ImageFamily | null;
  imageCapabilities?: ImageCapabilities | null;
  imagePricing?: ImagePricing | null;
}

/** Normalization refuses an image model without its family and capabilities. */
export class IncompleteImageModel extends Error {}

const NO_IMAGE = { imageFamily: null, imageCapabilities: null, imagePricing: null } as const;

export const EMPTY_CAPABILITIES: ModelCapabilities = {
  imageOutput: false,
  reasoning: false,
  tools: false,
  vision: false,
  files: false,
};

export const normalizeModelSettings = (settings: UnnormalizedModelSettings): ModelSettings => {
  const groupIds = settings.access === "groups" ? [...new Set(settings.groupIds)] : [];

  if (settings.type === "image") {
    const { imageFamily, imageCapabilities } = settings;
    if (!imageFamily || !imageCapabilities)
      throw new IncompleteImageModel("An image model needs its family and capabilities.");
    return {
      ...settings,
      type: "image",
      embeddingDimensions: null,
      contextLength: null,
      format: null,
      capabilities: { ...EMPTY_CAPABILITIES },
      pricing: null,
      imageFamily,
      imageCapabilities: effectiveImageCapabilities(imageFamily, imageCapabilities),
      imagePricing: settings.imagePricing ?? null,
      groupIds,
    };
  }

  if (settings.type === "embedding") {
    return {
      ...settings,
      ...NO_IMAGE,
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
    ...NO_IMAGE,
    type: "chat",
    embeddingDimensions: null,
    capabilities: settings.capabilities.reasoning ? settings.capabilities : withoutEfforts,
    pricing: settings.pricing?.output === null ? null : settings.pricing,
    groupIds,
  };
};
