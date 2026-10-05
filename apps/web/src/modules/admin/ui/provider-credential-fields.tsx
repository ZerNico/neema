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
import { OptionalMark } from "~/ui/form/app-form.tsx";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";

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
  const placeholder = stored === auth ? { placeholder: "Unchanged" } : {};
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
          label="Sign in with"
          about="A Bedrock API key, or an IAM user’s access key, which signs each request."
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
          {input("accessKeyId", "Access key ID", false)}
          {input("secretAccessKey", "Secret access key", true)}
        </>
      ) : (
        input("apiKey", "API key", true, !preset.keyRequired && stored === undefined)
      )}
    </>
  );
}
