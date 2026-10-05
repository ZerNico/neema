import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState, type Dispatch, type SetStateAction } from "react";
import {
  EMPTY_CAPABILITIES,
  MODEL_FORMATS,
  MODEL_TYPES,
  REASONING_EFFORTS,
  normalizeModelSettings,
  type ModelAccess,
  type ModelCapabilities,
  type ModelFormat,
  type ModelSettings,
  type ModelType,
} from "~/modules/providers/model-config.ts";
import { CAPABILITY_META } from "~/modules/providers/ui/capability-icons.tsx";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "~/ui/primitives/combobox";
import {
  FieldError,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldTitle,
} from "~/ui/primitives/field";
import { FieldSet } from "~/ui/field-set.tsx";
import { MODEL_DESCRIPTION_MAX } from "../schema.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { OptionalMark } from "~/ui/form/app-form.tsx";

/**
 * Sentence-case labels for the type enum wherever it is shown to a person
 * (badges, selects). The enum values themselves stay lowercase on the wire.
 */
export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  chat: "Chat",
  embedding: "Embedding",
};

const MODEL_TYPE_ITEMS = MODEL_TYPES.map((value) => ({ value, label: MODEL_TYPE_LABELS[value] }));

export const MODEL_FORMAT_LABELS: Record<ModelFormat, string> = {
  responses: "Responses",
  "chat-completions": "Chat Completions",
};

const MODEL_FORMAT_ITEMS = MODEL_FORMATS.map((value) => ({
  value,
  label: MODEL_FORMAT_LABELS[value],
}));

const ACCESS_ITEMS: { value: ModelAccess; label: string }[] = [
  { value: "public", label: "Public" },
  { value: "groups", label: "Private" },
];

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

const parsePrice = (raw: string): number | null | undefined => {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

const parsePositiveInteger = (raw: string): number | null | undefined => {
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

export function ModelSettingsFields({
  draft,
  setDraft,
  groups,
  modelKey,
  onDetectDimensions,
  autoFocusDisplayName = false,
  disabled = false,
}: {
  draft: ModelSettingsDraft;
  setDraft: Dispatch<SetStateAction<ModelSettingsDraft>>;
  groups: PickableGroup[];
  modelKey?: string;
  /**
   * Asks the provider for the vector width with one probe request. Resolves to
   * a number to fill in, or a message to show; absent hides the control.
   */
  onDetectDimensions?:
    | (() => Promise<{ ok: true; dimensions: number } | { ok: false; error: string }>)
    | undefined;
  autoFocusDisplayName?: boolean;
  disabled?: boolean;
}) {
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const id = useId();
  const groupAnchor = useComboboxAnchor();
  const contextInvalid =
    draft.contextLength.trim() !== "" && parsePositiveInteger(draft.contextLength) === undefined;
  const dimensionsInvalid =
    draft.embeddingDimensions.trim() !== "" &&
    parsePositiveInteger(draft.embeddingDimensions) === undefined;
  const inputPriceInvalid =
    draft.inputPrice.trim() !== "" && parsePrice(draft.inputPrice) === undefined;
  const outputPriceInvalid =
    draft.outputPrice.trim() !== "" && parsePrice(draft.outputPrice) === undefined;
  const cacheReadInvalid =
    draft.cacheReadPrice.trim() !== "" && parsePrice(draft.cacheReadPrice) === undefined;
  const cacheWriteInvalid =
    draft.cacheWritePrice.trim() !== "" && parsePrice(draft.cacheWritePrice) === undefined;
  const partialChatPricing =
    draft.type === "chat" && (draft.inputPrice.trim() === "") !== (draft.outputPrice.trim() === "");
  const visibleCapabilities =
    draft.type === "chat"
      ? CAPABILITY_META
      : CAPABILITY_META.filter((capability) => capability.key === "vision");

  const patch = (next: Partial<ModelSettingsDraft>) =>
    setDraft((current) => ({ ...current, ...next }));

  return (
    <>
      <FieldSet compact disabled={disabled}>
        <FieldLegend variant="label">General</FieldLegend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-display-name`}>Display name</FieldLabel>
            <Input
              id={`${id}-display-name`}
              value={draft.displayName}
              onChange={(event) => patch({ displayName: event.target.value })}
              autoFocus={autoFocusDisplayName}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-type`}>Type</FieldLabel>
            <Select
              value={draft.type}
              onValueChange={(value) => value && patch({ type: value as ModelType })}
              items={MODEL_TYPE_ITEMS}
            >
              <SelectTrigger id={`${id}-type`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_TYPE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {draft.type === "chat" && draft.format !== null ? (
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-format`}>API</FieldLabel>
              <Select
                value={draft.format}
                onValueChange={(value) => value && patch({ format: value as ModelFormat })}
                items={MODEL_FORMAT_ITEMS}
              >
                <SelectTrigger id={`${id}-format`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_FORMAT_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Switches to Chat Completions by itself when a deployment refuses Responses.
              </FieldDescription>
            </Field>
          ) : null}
          {draft.type === "chat" ? (
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-description`}>
                Description <OptionalMark />
              </FieldLabel>
              <Input
                id={`${id}-description`}
                value={draft.description}
                maxLength={MODEL_DESCRIPTION_MAX}
                placeholder="Fast, good for everyday questions"
                onChange={(event) => patch({ description: event.target.value })}
              />
              <FieldDescription>Shown under the name when someone picks a model.</FieldDescription>
            </Field>
          ) : null}
          {modelKey === undefined ? null : (
            <Field>
              <FieldLabel htmlFor={`${id}-model-key`}>Model ID</FieldLabel>
              <Input id={`${id}-model-key`} value={modelKey} readOnly />
              <FieldDescription>The provider-side identifier cannot be changed.</FieldDescription>
            </Field>
          )}
          <Field data-invalid={contextInvalid}>
            <FieldLabel htmlFor={`${id}-context-length`}>
              {draft.type === "chat" ? "Context length" : "Max input tokens"} <OptionalMark />
            </FieldLabel>
            <Input
              id={`${id}-context-length`}
              type="number"
              min={1}
              step={1}
              value={draft.contextLength}
              onChange={(event) => patch({ contextLength: event.target.value })}
              placeholder="Unknown"
              aria-invalid={contextInvalid}
            />
            {draft.type === "chat" ? (
              <FieldDescription>Largest request the model accepts, in tokens.</FieldDescription>
            ) : null}
          </Field>
          {draft.type === "embedding" ? (
            <Field data-invalid={dimensionsInvalid}>
              <FieldLabel htmlFor={`${id}-embedding-dimensions`}>
                Dimensions <OptionalMark />
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id={`${id}-embedding-dimensions`}
                  type="number"
                  min={1}
                  step={1}
                  value={draft.embeddingDimensions}
                  onChange={(event) => patch({ embeddingDimensions: event.target.value })}
                  placeholder="Provider default"
                  aria-invalid={dimensionsInvalid}
                />
                {onDetectDimensions ? (
                  <PendingButton
                    pending={detecting}
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setDetecting(true);
                      setDetectError(null);
                      void onDetectDimensions()
                        .then((result) => {
                          if (result.ok) patch({ embeddingDimensions: String(result.dimensions) });
                          else setDetectError(result.error);
                        })
                        .catch((error: unknown) =>
                          setDetectError(
                            error instanceof Error
                              ? error.message
                              : "Could not detect embedding dimensions.",
                          ),
                        )
                        .finally(() => setDetecting(false));
                    }}
                  >
                    Detect
                  </PendingButton>
                ) : null}
              </div>
              {detectError ? <FieldError>{detectError}</FieldError> : null}
              <FieldDescription>
                Catalogs don’t list this. Detect asks the model, or leave it empty to use its
                default.
              </FieldDescription>
            </Field>
          ) : null}
        </div>
        <FieldLabel htmlFor={`${id}-enabled`}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle id={`${id}-enabled-title`}>Enabled</FieldTitle>
              <FieldDescription>Turn off to hide it everywhere.</FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-enabled`}
              aria-labelledby={`${id}-enabled-title`}
              checked={draft.enabled}
              onCheckedChange={(enabled) => patch({ enabled })}
            />
          </Field>
        </FieldLabel>
      </FieldSet>

      <FieldSet compact disabled={disabled}>
        <FieldLegend variant="label">Capabilities</FieldLegend>
        {draft.type === "embedding" ? (
          <FieldDescription>
            Multimodal embedding models can accept images as input.
          </FieldDescription>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          {visibleCapabilities.map((capability) => {
            const label = draft.type === "embedding" ? "Image input" : capability.label;
            const switchId = `${id}-capability-${capability.key}`;
            return (
              <FieldLabel key={capability.key} htmlFor={switchId}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle id={`${switchId}-title`}>
                      <HugeiconsIcon
                        icon={capability.icon}
                        strokeWidth={2}
                        className="text-muted-foreground size-4"
                      />
                      {label}
                    </FieldTitle>
                  </FieldContent>
                  <Switch
                    id={switchId}
                    aria-labelledby={`${switchId}-title`}
                    checked={draft.capabilities[capability.key]}
                    onCheckedChange={(checked) =>
                      patch({
                        capabilities: {
                          ...draft.capabilities,
                          [capability.key]: checked,
                        },
                      })
                    }
                  />
                </Field>
              </FieldLabel>
            );
          })}
        </div>
        {draft.type === "chat" && draft.capabilities.reasoning ? (
          <Field>
            <FieldTitle>Reasoning effort levels</FieldTitle>
            <FieldDescription>
              Choose the levels people can select. Leave empty to use the model’s default.
            </FieldDescription>
            <ToggleGroup
              multiple
              variant="choice"
              size="sm"
              className="flex-wrap"
              aria-label="Allowed reasoning levels"
              value={[...(draft.capabilities.reasoningEfforts ?? [])]}
              onValueChange={(values) =>
                setDraft((current) => ({
                  ...current,
                  capabilities: {
                    ...current.capabilities,
                    reasoningEfforts: REASONING_EFFORTS.filter((effort) => values.includes(effort)),
                  },
                }))
              }
            >
              {REASONING_EFFORTS.map((effort) => (
                <ToggleGroupItem key={effort} value={effort}>
                  {effort === "none"
                    ? "Off"
                    : effort === "xhigh"
                      ? "Extra high"
                      : effort === "max"
                        ? "Maximum"
                        : effort[0]!.toUpperCase() + effort.slice(1)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        ) : null}
      </FieldSet>

      <FieldSet compact disabled={disabled}>
        <FieldLegend variant="label">
          Pricing <OptionalMark />
        </FieldLegend>
        <FieldDescription>
          USD per 1M tokens, used when the provider doesn’t report a cost.
        </FieldDescription>
        <div className="grid grid-cols-2 gap-3">
          <Field data-invalid={inputPriceInvalid || partialChatPricing}>
            <FieldLabel htmlFor={`${id}-input-price`}>Input $/1M</FieldLabel>
            <Input
              id={`${id}-input-price`}
              inputMode="decimal"
              value={draft.inputPrice}
              onChange={(event) => patch({ inputPrice: event.target.value })}
              placeholder="Unknown"
              aria-invalid={inputPriceInvalid || partialChatPricing}
            />
          </Field>
          {draft.type === "chat" ? (
            <Field data-invalid={outputPriceInvalid || partialChatPricing}>
              <FieldLabel htmlFor={`${id}-output-price`}>Output $/1M</FieldLabel>
              <Input
                id={`${id}-output-price`}
                inputMode="decimal"
                value={draft.outputPrice}
                onChange={(event) => patch({ outputPrice: event.target.value })}
                placeholder="Unknown"
                aria-invalid={outputPriceInvalid || partialChatPricing}
              />
            </Field>
          ) : null}
          {draft.type === "chat" ? (
            <>
              <Field data-invalid={cacheReadInvalid}>
                <FieldLabel htmlFor={`${id}-cache-read-price`}>Cache read $/1M</FieldLabel>
                <Input
                  id={`${id}-cache-read-price`}
                  inputMode="decimal"
                  value={draft.cacheReadPrice}
                  onChange={(event) => patch({ cacheReadPrice: event.target.value })}
                  placeholder="Input price"
                  aria-invalid={cacheReadInvalid}
                />
              </Field>
              <Field data-invalid={cacheWriteInvalid}>
                <FieldLabel htmlFor={`${id}-cache-write-price`}>Cache write $/1M</FieldLabel>
                <Input
                  id={`${id}-cache-write-price`}
                  inputMode="decimal"
                  value={draft.cacheWritePrice}
                  onChange={(event) => patch({ cacheWritePrice: event.target.value })}
                  placeholder="Input price"
                  aria-invalid={cacheWriteInvalid}
                />
              </Field>
            </>
          ) : null}
        </div>
      </FieldSet>

      <FieldSet compact disabled={disabled}>
        <FieldLegend variant="label">Access</FieldLegend>
        <Field>
          <FieldLabel htmlFor={`${id}-access`}>Visibility</FieldLabel>
          <Select
            value={draft.access}
            onValueChange={(value) => value && patch({ access: value as ModelAccess })}
            items={ACCESS_ITEMS}
          >
            <SelectTrigger id={`${id}-access`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCESS_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            {draft.access === "public"
              ? "Available to everyone."
              : "Only admins and members of the selected groups can use it."}
          </FieldDescription>
        </Field>
        {draft.access === "groups" ? (
          <Field>
            <FieldLabel htmlFor={`${id}-groups`}>Allowed groups</FieldLabel>
            <Combobox
              multiple
              items={groups}
              value={draft.selectedGroups}
              onValueChange={(selectedGroups: PickableGroup[]) => patch({ selectedGroups })}
              itemToStringLabel={(group: PickableGroup) => group.name}
              isItemEqualToValue={(a: PickableGroup, b: PickableGroup) => a.id === b.id}
              filter={(group: PickableGroup, query: string) =>
                group.name.toLowerCase().includes(query.trim().toLowerCase())
              }
              autoHighlight
            >
              <ComboboxChips ref={groupAnchor}>
                <ComboboxValue>
                  {(value: PickableGroup[]) => (
                    <>
                      {value.map((group) => (
                        <ComboboxChip key={group.id} aria-label={group.name}>
                          {group.name}
                        </ComboboxChip>
                      ))}
                      <ComboboxChipsInput
                        id={`${id}-groups`}
                        placeholder={value.length ? "" : "Add groups…"}
                      />
                    </>
                  )}
                </ComboboxValue>
              </ComboboxChips>
              <ComboboxContent anchor={groupAnchor} side="bottom">
                <ComboboxEmpty>
                  {groups.length === 0 ? "No groups exist yet." : "No groups match."}
                </ComboboxEmpty>
                <ComboboxList>
                  {(group: PickableGroup) => (
                    <ComboboxItem key={group.id} value={group}>
                      {group.name}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            {draft.selectedGroups.length === 0 ? (
              <FieldDescription>Visible to admins only until a group is added.</FieldDescription>
            ) : null}
          </Field>
        ) : null}
      </FieldSet>
    </>
  );
}
