import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import {
  effectiveSettings,
  PRESETS,
  type Preset,
  type PresetId,
  type ProviderSettings,
  type ReasoningShape,
  type SettingKey,
} from "@chat/model-client/presets";
import { FORMAT_LABELS, REASONING_LABELS } from "./provider-settings-labels.ts";
import { Button } from "~/ui/primitives/button";
import { Field, FieldContent, FieldLabel, FieldTitle } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";

/** What a setting does and when to change it, behind an icon beside its label. */
function About({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`About ${label}`} />
        }
      >
        <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}

function ChoiceField<T extends string>({
  id,
  label,
  about,
  value,
  labels,
  options,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  about: ReactNode;
  value: T;
  labels: Record<T, string>;
  options: ReadonlyArray<T>;
  onChange: (value: T) => void;
  disabled?: boolean | undefined;
}) {
  const items = options.map((option) => ({ value: option, label: labels[option] }));
  return (
    <Field>
      <div className="flex items-center gap-1">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <About label={label}>{about}</About>
      </div>
      <Select
        value={value}
        onValueChange={(next) => next && onChange(next as T)}
        items={items}
        {...(disabled ? { disabled } : {})}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function ToggleField({
  id,
  label,
  about,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  about: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <div className="flex items-center gap-1">
          <FieldTitle id={`${id}-title`}>{label}</FieldTitle>
          <About label={label}>{about}</About>
        </div>
      </FieldContent>
      <Switch
        id={id}
        aria-labelledby={`${id}-title`}
        checked={checked}
        onCheckedChange={onChange}
        {...(disabled ? { disabled } : {})}
      />
    </Field>
  );
}

/**
 * The request settings a preset lets an admin change, each starting at the
 * preset's value. Shared by adding and editing a provider, so a new one never
 * starts with settings nobody was shown.
 */
export function ProviderSettingsFields({
  id,
  preset,
  settings,
  onChange,
  disabled,
}: {
  id: string;
  preset: Preset;
  settings: ProviderSettings;
  onChange: (settings: ProviderSettings) => void;
  disabled?: boolean | undefined;
}) {
  const effective = effectiveSettings(preset, settings);
  const can = (key: SettingKey) => preset.overridable.includes(key);
  const set = <K extends SettingKey>(key: K, value: ProviderSettings[K] | undefined) => {
    const { [key]: _, ...rest } = settings;
    onChange(value === undefined ? rest : { ...rest, [key]: value });
  };
  const chat = effective.format === "chat-completions";
  return (
    <>
      {can("format") && preset.formats.length > 1 ? (
        <ChoiceField
          id={`${id}-format`}
          label="API"
          about="Chat Completions works with almost every server. Responses is OpenAI’s newer API, for servers that offer it."
          value={effective.format}
          labels={FORMAT_LABELS}
          options={preset.formats}
          onChange={(format) => set("format", format)}
          disabled={disabled}
        />
      ) : null}
      {can("reasoning") && chat ? (
        <ChoiceField
          id={`${id}-reasoning`}
          label="Reasoning level field"
          about="The request field that carries the reasoning level picked in a chat. Most servers read reasoning_effort, OpenRouter-style gateways reasoning.effort. Not sent hides the level picker."
          value={effective.reasoning}
          labels={REASONING_LABELS}
          options={Object.keys(REASONING_LABELS) as ReasoningShape[]}
          onChange={(reasoning) => set("reasoning", reasoning)}
          disabled={disabled}
        />
      ) : null}
      {can("keyHeader") ? (
        <Field>
          <div className="flex items-center gap-1">
            <FieldLabel htmlFor={`${id}-key-header`}>Key header</FieldLabel>
            <About label="Key header">
              The header the API key goes in. Empty sends it as Authorization: Bearer. Some gateways
              want api-key or x-api-key.
            </About>
          </div>
          <Input
            id={`${id}-key-header`}
            value={settings.keyHeader ?? ""}
            onChange={(event) =>
              set("keyHeader", event.target.value.trim() ? event.target.value.trim() : undefined)
            }
            placeholder="Authorization: Bearer"
            {...(disabled ? { disabled } : {})}
          />
        </Field>
      ) : null}
      {can("sendReasoning") && chat ? (
        <ToggleField
          id={`${id}-send-reasoning`}
          label="Send reasoning back"
          about="Gives a model its own reasoning back on the next tool round. DeepSeek, Kimi and GLM need it. Turn off if the server rejects it."
          checked={effective.sendReasoning}
          onChange={(sendReasoning) => set("sendReasoning", sendReasoning)}
          disabled={disabled}
        />
      ) : null}
      {can("streamUsage") && chat ? (
        <ToggleField
          id={`${id}-stream-usage`}
          label="Ask for token usage"
          about="Asks the server to report token counts, for usage and cost. Turn off if it rejects stream_options."
          checked={effective.streamUsage}
          onChange={(streamUsage) => set("streamUsage", streamUsage)}
          disabled={disabled}
        />
      ) : null}
    </>
  );
}

export function PresetSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: PresetId;
  onChange: (preset: PresetId) => void;
  disabled?: boolean | undefined;
}) {
  const items = PRESETS.map((preset) => ({ value: preset.id, label: preset.label }));
  return (
    <Select
      value={value}
      onValueChange={(next) => next && onChange(next as PresetId)}
      items={items}
      {...(disabled ? { disabled } : {})}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PRESETS.map((preset) => (
          <SelectItem key={preset.id} value={preset.id}>
            {preset.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
