import { HugeiconsIcon } from "@hugeicons/react";
import type { Dispatch, SetStateAction } from "react";
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
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";

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
}: {
  draft: ModelSettingsDraft;
  setDraft: Dispatch<SetStateAction<ModelSettingsDraft>>;
  groups: PickableGroup[];
  modelKey?: string;
  autoFocusDisplayName?: boolean;
}) {
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
      <section className="flex flex-col gap-4">
        <h3 className="text-sm font-medium">General</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="model-display-name">Display name</FieldLabel>
            <Input
              id="model-display-name"
              value={draft.displayName}
              onChange={(event) => patch({ displayName: event.target.value })}
              autoFocus={autoFocusDisplayName}
            />
          </Field>
          <Field>
            <FieldLabel>Type</FieldLabel>
            <Select
              value={draft.type}
              onValueChange={(value) => value && patch({ type: value as ModelType })}
              items={MODEL_TYPES.map((value) => ({ value, label: value }))}
            >
              <SelectTrigger aria-label="Type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {modelKey === undefined ? null : (
            <Field>
              <FieldLabel htmlFor="model-key">Model ID</FieldLabel>
              <Input id="model-key" value={modelKey} readOnly />
              <FieldDescription>The provider-side identifier cannot be changed.</FieldDescription>
            </Field>
          )}
          <Field data-invalid={contextInvalid}>
            <FieldLabel htmlFor="model-context-length">
              {draft.type === "chat" ? "Context length" : "Max input tokens"}
            </FieldLabel>
            <Input
              id="model-context-length"
              type="number"
              min={1}
              step={1}
              value={draft.contextLength}
              onChange={(event) => patch({ contextLength: event.target.value })}
              placeholder="Unknown"
              aria-invalid={contextInvalid}
            />
            <FieldDescription className="text-xs">
              {draft.type === "chat"
                ? "Maximum context window in tokens. Leave empty if unknown."
                : "Leave empty if unknown."}
            </FieldDescription>
          </Field>
          {draft.type === "embedding" ? (
            <Field data-invalid={dimensionsInvalid}>
              <FieldLabel htmlFor="model-embedding-dimensions">Dimensions</FieldLabel>
              <Input
                id="model-embedding-dimensions"
                type="number"
                min={1}
                step={1}
                value={draft.embeddingDimensions}
                onChange={(event) => patch({ embeddingDimensions: event.target.value })}
                placeholder="Provider default"
                aria-invalid={dimensionsInvalid}
              />
              <FieldDescription className="text-xs">
                Leave empty to use the provider default.
              </FieldDescription>
            </Field>
          ) : null}
        </div>
        <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">Enabled</span>
            <span className="text-muted-foreground text-xs">
              Disabled models are unavailable to application features.
            </span>
          </span>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
            aria-label="Model enabled"
          />
        </label>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Capabilities</h3>
          {draft.type === "embedding" ? (
            <p className="text-muted-foreground text-xs">
              Multimodal embedding models can accept images as input.
            </p>
          ) : null}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {visibleCapabilities.map((capability) => (
            <label
              key={capability.key}
              className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
            >
              <span className="flex items-center gap-2">
                <HugeiconsIcon icon={capability.icon} className="text-muted-foreground size-4" />
                {draft.type === "embedding" ? "Image input" : capability.label}
              </span>
              <Switch
                checked={draft.capabilities[capability.key]}
                onCheckedChange={(checked) =>
                  patch({
                    capabilities: {
                      ...draft.capabilities,
                      [capability.key]: checked,
                    },
                  })
                }
                aria-label={`${draft.type === "embedding" ? "Image input" : capability.label} capability`}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Pricing</h3>
          <p className="text-muted-foreground text-xs">
            USD per 1M tokens, used when the provider does not report its billed cost.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field data-invalid={inputPriceInvalid || partialChatPricing}>
            <FieldLabel htmlFor="model-input-price">Input $/1M</FieldLabel>
            <Input
              id="model-input-price"
              inputMode="decimal"
              value={draft.inputPrice}
              onChange={(event) => patch({ inputPrice: event.target.value })}
              placeholder="Unknown"
              aria-invalid={inputPriceInvalid || partialChatPricing}
            />
          </Field>
          {draft.type === "chat" ? (
            <Field data-invalid={outputPriceInvalid || partialChatPricing}>
              <FieldLabel htmlFor="model-output-price">Output $/1M</FieldLabel>
              <Input
                id="model-output-price"
                inputMode="decimal"
                value={draft.outputPrice}
                onChange={(event) => patch({ outputPrice: event.target.value })}
                placeholder="Unknown"
                aria-invalid={outputPriceInvalid || partialChatPricing}
              />
            </Field>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">
          {draft.type === "chat"
            ? "Leave both empty if pricing is unknown."
            : "Leave empty if pricing is unknown."}
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h3 className="text-sm font-medium">Access</h3>
        <Field>
          <FieldLabel>Visibility</FieldLabel>
          <Select
            value={draft.access}
            onValueChange={(value) => value && patch({ access: value as ModelAccess })}
            items={[
              { value: "public", label: "Public" },
              { value: "groups", label: "Private" },
            ]}
          >
            <SelectTrigger aria-label="Visibility">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public</SelectItem>
              <SelectItem value="groups">Private</SelectItem>
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
            <FieldLabel>Allowed groups</FieldLabel>
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
                      <ComboboxChipsInput placeholder={value.length ? "" : "Add groups…"} />
                    </>
                  )}
                </ComboboxValue>
              </ComboboxChips>
              <ComboboxContent anchor={groupAnchor} side="bottom">
                <ComboboxEmpty>
                  {groups.length === 0 ? "No groups exist yet" : "No groups match"}
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
              <p className="text-muted-foreground text-xs">
                Visible to admins only until a group is added.
              </p>
            ) : null}
          </Field>
        ) : null}
      </section>
    </>
  );
}
