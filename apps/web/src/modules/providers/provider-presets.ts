import {
  effectiveSettings,
  formatFor,
  getPreset,
  type PresetId,
  type ProviderSettings,
} from "@chat/model-client";

/** A stored provider as far as request shaping cares. */
export interface ProviderShape {
  readonly preset: PresetId;
  readonly settings: ProviderSettings;
}

export const settingsOf = (provider: ProviderShape) =>
  effectiveSettings(getPreset(provider.preset), provider.settings);

/**
 * Whether a reasoning level reaches the model at all. Responses and Messages
 * always take one; on Chat Completions only a preset (or an admin) that names
 * a request shape sends it, since strict servers refuse fields they do not know.
 */
export const sendsReasoningEffort = (provider: ProviderShape, modelKey: string) => {
  const settings = settingsOf(provider);
  const format = formatFor(getPreset(provider.preset), settings, modelKey);
  return format !== "chat-completions" || settings.reasoning !== "none";
};

/** Image output exists only where the preset asks for it per call (OpenRouter's modalities). */
export const supportsImageOutput = (provider: ProviderShape) =>
  getPreset(provider.preset).imageOutput && settingsOf(provider).format === "chat-completions";
