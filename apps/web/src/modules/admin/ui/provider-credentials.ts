import {
  effectiveSettings,
  type AuthKind,
  type Preset,
  type ProviderSettings,
} from "@chat/model-client/presets";

export interface CredentialDraft {
  apiKey: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const EMPTY_CREDENTIALS: CredentialDraft = {
  apiKey: "",
  accessKeyId: "",
  secretAccessKey: "",
};

/**
 * Whether the draft can be saved. `stored` is the kind a saved provider has:
 * a blank field keeps that, while switching kinds needs new credentials.
 */
export const credentialsReady = (
  preset: Preset,
  settings: ProviderSettings,
  draft: CredentialDraft,
  stored?: AuthKind,
) => {
  const auth = effectiveSettings(preset, settings).auth;
  if (auth === stored) return true;
  if (auth === "aws") return Boolean(draft.accessKeyId.trim() && draft.secretAccessKey.trim());
  return !preset.keyRequired || Boolean(draft.apiKey.trim());
};

/** The credentials the server is sent: only the kind in use, and only what was typed. */
export const credentialsInput = (
  preset: Preset,
  settings: ProviderSettings,
  draft: CredentialDraft,
) => {
  if (effectiveSettings(preset, settings).auth === "aws")
    return draft.accessKeyId.trim() && draft.secretAccessKey.trim()
      ? {
          awsKeys: {
            accessKeyId: draft.accessKeyId.trim(),
            secretAccessKey: draft.secretAccessKey.trim(),
          },
        }
      : {};
  return draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {};
};
