import {
  AUTH_KINDS,
  effectiveSettings,
  type AuthKind,
  type Preset,
  type ProviderSettings,
} from "@chat/model-client/presets";
import type { CredentialDraft } from "./provider-credentials.ts";
import { AUTH_LABELS } from "./provider-settings-labels.ts";
import { ChoiceField } from "./provider-settings-fields.tsx";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { m } from "~/paraglide/messages.js";

/** How a provider signs in, then the fields that kind needs. */
export function ProviderCredentialFields({
  id,
  preset,
  settings,
  onSettingsChange,
  draft,
  onChange,
  stored,
  disabled,
}: {
  id: string;
  preset: Preset;
  settings: ProviderSettings;
  onSettingsChange: (settings: ProviderSettings) => void;
  draft: CredentialDraft;
  onChange: (draft: CredentialDraft) => void;
  stored?: AuthKind | undefined;
  disabled?: boolean | undefined;
}) {
  const auth = effectiveSettings(preset, settings).auth;
  // A saved secret can't be shown: blank keeps it, unless the kind changed.
  const placeholder = stored === auth ? { placeholder: m.admin_credentials_unchanged() } : {};
  const input = (
    field: keyof CredentialDraft,
    label: string,
    secret: boolean,
    optional = false,
  ) => (
    <Field>
      <FieldLabel htmlFor={`${id}-${field}`}>
        {label} {optional ? <OptionalMark /> : null}
      </FieldLabel>
      <Input
        id={`${id}-${field}`}
        type={secret ? "password" : "text"}
        autoComplete="off"
        value={draft[field]}
        onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
        {...placeholder}
        {...(disabled ? { disabled } : {})}
      />
    </Field>
  );
  return (
    <>
      {preset.overridable.includes("auth") ? (
        <ChoiceField
          id={`${id}-auth`}
          label={m.admin_credentials_sign_in_with()}
          about={m.admin_credentials_sign_in_about()}
          value={auth}
          labels={AUTH_LABELS}
          options={AUTH_KINDS}
          onChange={(next) => {
            const { auth: _, ...rest } = settings;
            onSettingsChange(next === "key" ? rest : { ...rest, auth: next });
          }}
          disabled={disabled}
        />
      ) : null}
      {auth === "aws" ? (
        <>
          {input("accessKeyId", m.admin_credentials_access_key_id(), false)}
          {input("secretAccessKey", m.admin_credentials_secret_access_key(), true)}
        </>
      ) : (
        input(
          "apiKey",
          m.admin_credentials_api_key(),
          true,
          !preset.keyRequired && stored === undefined,
        )
      )}
    </>
  );
}
