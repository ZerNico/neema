import { HugeiconsIcon } from "@hugeicons/react";
import { useId, type Dispatch, type SetStateAction } from "react";
import {
  EMPTY_CAPABILITIES,
  MODEL_TYPES,
  normalizeModelSettings,
  type ModelAccess,
  type ModelCapabilities,
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
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";

// Sentence-case labels for the type enum wherever it is shown to a person
// (badges, selects). The enum values themselves stay lowercase on the wire.
export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  chat: "Chat",
  embedding: "Embedding",
};

const MODEL_TYPE_ITEMS = MODEL_TYPES.map((value) => ({ value, label: MODEL_TYPE_LABELS[value] }));

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
  type: ModelType;
  contextLength: string;
  embeddingDimensions: string;
  capabilities: ModelCapabilities;
  inputPrice: string;
  outputPrice: string;
  enabled: boolean;
  access: ModelAccess;
  selectedGroups: PickableGroup[];
}

export const emptyModelSettingsDraft = (): ModelSettingsDraft => ({
  displayName: "",
  type: "chat",
  contextLength: "",
  embeddingDimensions: "",
  capabilities: { ...EMPTY_CAPABILITIES },
  inputPrice: "",
  outputPrice: "",
  enabled: true,
  access: "public",
  selectedGroups: [],
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
  const clearingPricing = inputPrice === null && outputPrice === null;
  if (
    outputPrice === undefined ||
    (!clearingPricing && (inputPrice === null || outputPrice === null))
  ) {
    return null;
  }

  return normalizeModelSettings({
    displayName: draft.displayName.trim(),
    type: "chat",
    contextLength,
    embeddingDimensions: null,
    capabilities: draft.capabilities,
    pricing:
      inputPrice === null || outputPrice === null
        ? null
        : { input: inputPrice, output: outputPrice },
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
  autoFocusDisplayName = false,
  disabled = false,
}: {
  draft: ModelSettingsDraft;
  setDraft: Dispatch<SetStateAction<ModelSettingsDraft>>;
  groups: PickableGroup[];
  modelKey?: string;
  autoFocusDisplayName?: boolean;
  disabled?: boolean;
}) {
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
      <FieldSet className="gap-4" disabled={disabled}>
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
          {modelKey === undefined ? null : (
            <Field>
              <FieldLabel htmlFor={`${id}-model-key`}>Model ID</FieldLabel>
              <Input id={`${id}-model-key`} value={modelKey} readOnly />
              <FieldDescription>The provider-side identifier cannot be changed.</FieldDescription>
            </Field>
          )}
          <Field data-invalid={contextInvalid}>
            <FieldLabel htmlFor={`${id}-context-length`}>
              {draft.type === "chat" ? "Context length" : "Max input tokens"}
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
            <FieldDescription>
              {draft.type === "chat"
                ? "Maximum context window in tokens. Leave empty if unknown."
                : "Leave empty if unknown."}
            </FieldDescription>
          </Field>
          {draft.type === "embedding" ? (
            <Field data-invalid={dimensionsInvalid}>
              <FieldLabel htmlFor={`${id}-embedding-dimensions`}>Dimensions</FieldLabel>
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
              <FieldDescription>Leave empty to use the provider default.</FieldDescription>
            </Field>
          ) : null}
        </div>
        <FieldLabel htmlFor={`${id}-enabled`}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle id={`${id}-enabled-title`}>Enabled</FieldTitle>
              <FieldDescription>
                Disabled models are unavailable to application features.
              </FieldDescription>
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

      <FieldSet className="gap-3" disabled={disabled}>
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
      </FieldSet>

      <FieldSet className="gap-3" disabled={disabled}>
        <FieldLegend variant="label">Pricing</FieldLegend>
        <FieldDescription>
          USD per 1M tokens, used when the provider does not report its billed cost.
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
        </div>
        <FieldDescription>
          {draft.type === "chat"
            ? "Leave both empty if pricing is unknown."
            : "Leave empty if pricing is unknown."}
        </FieldDescription>
      </FieldSet>

      <FieldSet className="gap-4" disabled={disabled}>
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
