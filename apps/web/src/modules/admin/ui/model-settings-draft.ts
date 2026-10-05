import {
  EMPTY_CAPABILITIES,
  normalizeModelSettings,
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
}

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
