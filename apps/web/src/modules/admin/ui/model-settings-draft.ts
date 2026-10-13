import type {
  ImageCapabilities,
  ImageFamily,
  ImageQuality,
} from "@chat/model-client/image-families";
import {
  EMPTY_CAPABILITIES,
  normalizeModelSettings,
  type ImagePricing,
  type ModelAccess,
  type ModelCapabilities,
  type ModelFormat,
  type ModelSettings,
  type ModelType,
} from "~/modules/providers/model-config.ts";

export interface PickableGroup {
  id: string;
  name: string;
}

export interface ModelSettingsDraft {
  displayName: string;
  description: string;
  type: ModelType;
  contextLength: string;
  embeddingDimensions: string;
  capabilities: ModelCapabilities;
  inputPrice: string;
  outputPrice: string;
  /** Optional: blank prices a cached read or a cache write as ordinary input. */
  cacheReadPrice: string;
  cacheWritePrice: string;
  enabled: boolean;
  access: ModelAccess;
  selectedGroups: PickableGroup[];
  /** The model's API, where its preset lets models differ (Azure); null elsewhere. */
  format: ModelFormat | null;
  /** Image models: the request shape it is called with, and what it may do. */
  imageFamily: ImageFamily | null;
  imageCapabilities: ImageCapabilities | null;
  /** USD as typed: per image (`default`, by quality) and per 1M tokens. */
  imagePrices: Record<ImagePriceKey, string>;
}

export const IMAGE_PRICE_KEYS = [
  "default",
  "low",
  "medium",
  "high",
  "textInput",
  "imageInput",
  "output",
] as const;
export type ImagePriceKey = (typeof IMAGE_PRICE_KEYS)[number];

const emptyImagePrices = (): Record<ImagePriceKey, string> => ({
  default: "",
  low: "",
  medium: "",
  high: "",
  textInput: "",
  imageInput: "",
  output: "",
});

/** The families whose APIs report the token usage that token prices apply to. */
export const takesTokenPrices = (family: ImageFamily | null) =>
  family === "gpt-image" || family === "gemini-image";

/**
 * Clears the prices the form no longer shows, after a family or quality change:
 * a hidden half-typed price would otherwise block Save with nothing to fix.
 */
export const shownImagePrices = (
  prices: Record<ImagePriceKey, string>,
  family: ImageFamily | null,
  qualities: ReadonlyArray<ImageQuality>,
): Record<ImagePriceKey, string> =>
  Object.fromEntries(
    IMAGE_PRICE_KEYS.map((key) => {
      const shown =
        key === "default" ||
        (qualities as ReadonlyArray<string>).includes(key) ||
        (takesTokenPrices(family) &&
          (key === "textInput" || key === "imageInput" || key === "output"));
      return [key, shown ? prices[key] : ""];
    }),
  ) as Record<ImagePriceKey, string>;

const priceText = (value: number | undefined) => (value === undefined ? "" : String(value));

/** The draft fields an image model's stored prices fill in. */
export const imagePricesOf = (pricing: ImagePricing | null): Record<ImagePriceKey, string> => {
  return {
    default: priceText(pricing?.perImage?.default),
    low: priceText(pricing?.perImage?.low),
    medium: priceText(pricing?.perImage?.medium),
    high: priceText(pricing?.perImage?.high),
    textInput: priceText(pricing?.tokens?.textInput),
    imageInput: priceText(pricing?.tokens?.imageInput),
    output: priceText(pricing?.tokens?.output),
  };
};

/** Token prices go together or not at all; per-image ones each stand alone. */
const imagePricingOf = (prices: Record<ImagePriceKey, string>): ImagePricing | null | undefined => {
  const parsed = Object.fromEntries(
    IMAGE_PRICE_KEYS.map((key) => [key, parsePrice(prices[key])]),
  ) as Record<ImagePriceKey, number | null | undefined>;
  if (Object.values(parsed).some((value) => value === undefined)) return undefined;
  const tokenKeys = ["textInput", "imageInput", "output"] as const;
  const tokensSet = tokenKeys.filter((key) => parsed[key] !== null).length;
  if (tokensSet !== 0 && tokensSet !== tokenKeys.length) return undefined;
  const perImage = Object.fromEntries(
    (["default", "low", "medium", "high"] as const).flatMap((key) =>
      parsed[key] === null ? [] : [[key, parsed[key]]],
    ),
  );
  const pricing: ImagePricing = {
    ...(tokensSet
      ? {
          tokens: {
            textInput: parsed.textInput!,
            imageInput: parsed.imageInput!,
            output: parsed.output!,
          },
        }
      : {}),
    ...(Object.keys(perImage).length ? { perImage } : {}),
  };
  return pricing.tokens || pricing.perImage ? pricing : null;
};

export const emptyModelSettingsDraft = (): ModelSettingsDraft => ({
  displayName: "",
  description: "",
  type: "chat",
  contextLength: "",
  embeddingDimensions: "",
  capabilities: { ...EMPTY_CAPABILITIES },
  inputPrice: "",
  outputPrice: "",
  cacheReadPrice: "",
  cacheWritePrice: "",
  enabled: true,
  access: "public",
  selectedGroups: [],
  format: null,
  imageFamily: null,
  imageCapabilities: null,
  imagePrices: emptyImagePrices(),
});

export const parsePrice = (raw: string): number | null | undefined => {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

export const parsePositiveInteger = (raw: string): number | null | undefined => {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
};

export const modelSettingsFromDraft = (draft: ModelSettingsDraft): ModelSettings | null => {
  if (draft.type === "image") {
    const imagePricing = imagePricingOf(draft.imagePrices);
    if (
      draft.displayName.trim() === "" ||
      !draft.imageFamily ||
      !draft.imageCapabilities ||
      draft.imageCapabilities.aspectRatios.length === 0 ||
      imagePricing === undefined
    )
      return null;
    return normalizeModelSettings({
      displayName: draft.displayName.trim(),
      description: draft.description.trim() || null,
      type: "image",
      contextLength: null,
      embeddingDimensions: null,
      capabilities: { ...EMPTY_CAPABILITIES },
      pricing: null,
      imageFamily: draft.imageFamily,
      imageCapabilities: draft.imageCapabilities,
      imagePricing,
      enabled: draft.enabled,
      access: draft.access,
      groupIds: draft.selectedGroups.map((group) => group.id),
    });
  }
  const contextLength = parsePositiveInteger(draft.contextLength);
  if (draft.displayName.trim() === "" || contextLength === undefined) return null;

  const inputPrice = parsePrice(draft.inputPrice);
  if (inputPrice === undefined) return null;

  if (draft.type === "embedding") {
    const embeddingDimensions = parsePositiveInteger(draft.embeddingDimensions);
    if (embeddingDimensions === undefined) return null;
    return normalizeModelSettings({
      displayName: draft.displayName.trim(),
      description: draft.description.trim() || null,
      type: "embedding",
      contextLength,
      embeddingDimensions,
      capabilities: draft.capabilities,
      pricing: inputPrice === null ? null : { input: inputPrice, output: null },
      enabled: draft.enabled,
      access: draft.access,
      groupIds: draft.selectedGroups.map((group) => group.id),
    });
  }

  const outputPrice = parsePrice(draft.outputPrice);
  const cacheRead = parsePrice(draft.cacheReadPrice);
  const cacheWrite = parsePrice(draft.cacheWritePrice);
  const clearingPricing = inputPrice === null && outputPrice === null;
  if (
    outputPrice === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    (!clearingPricing && (inputPrice === null || outputPrice === null))
  ) {
    return null;
  }

  return normalizeModelSettings({
    displayName: draft.displayName.trim(),
    description: draft.description.trim() || null,
    type: "chat",
    format: draft.format,
    contextLength,
    embeddingDimensions: null,
    capabilities: draft.capabilities,
    pricing:
      inputPrice === null || outputPrice === null
        ? null
        : {
            input: inputPrice,
            output: outputPrice,
            ...(cacheRead === null ? {} : { cacheRead }),
            ...(cacheWrite === null ? {} : { cacheWrite }),
          },
    enabled: draft.enabled,
    access: draft.access,
    groupIds: draft.selectedGroups.map((group) => group.id),
  });
};
