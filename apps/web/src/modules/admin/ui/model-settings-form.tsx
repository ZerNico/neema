import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState, type Dispatch, type SetStateAction } from "react";
import {
  MODEL_FORMATS,
  MODEL_TYPES,
  REASONING_EFFORTS,
  type ModelAccess,
  type ModelFormat,
  type ModelType,
} from "~/modules/providers/model-config.ts";
import { CAPABILITY_META } from "~/modules/providers/ui/capability-meta.ts";
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
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import {
  parsePositiveInteger,
  parsePrice,
  type ModelSettingsDraft,
  type PickableGroup,
} from "./model-settings-draft.ts";
import { MODEL_TYPE_LABELS, MODEL_FORMAT_LABELS } from "./model-settings-labels.ts";
import { ImageModelFields } from "./image-model-fields.tsx";
import type { ImageFamilyInfo } from "@chat/model-client/image-families";
import { m } from "~/paraglide/messages.js";

const modelTypeItems = (images: boolean) =>
  MODEL_TYPES.filter((value) => images || value !== "image").map((value) => ({
    value,
    label: MODEL_TYPE_LABELS[value],
  }));

// API names, the same in every language.
const MODEL_FORMAT_ITEMS = MODEL_FORMATS.map((value) => ({
  value,
  label: MODEL_FORMAT_LABELS[value],
}));

const NO_IMAGE_FAMILIES: ReadonlyArray<ImageFamilyInfo> = [];

const accessItems = (): { value: ModelAccess; label: string }[] => [
  { value: "public", label: m.admin_access_public() },
  { value: "groups", label: m.admin_access_private() },
];

export function ModelSettingsFields({
  draft,
  setDraft,
  groups,
  modelKey,
  onDetectDimensions,
  autoFocusDisplayName = false,
  disabled = false,
  imageFamilies = NO_IMAGE_FAMILIES,
}: {
  /** The image families this provider hosts; empty offers no image type. */
  imageFamilies?: ReadonlyArray<ImageFamilyInfo>;
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
  const typeItems = modelTypeItems(imageFamilies.length > 0 || draft.type === "image");
  const image = draft.type === "image";
  const ACCESS_ITEMS = accessItems();

  return (
    <>
      <FieldSet compact disabled={disabled}>
        <FieldLegend variant="label">{m.admin_model_general()}</FieldLegend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-display-name`}>{m.admin_model_display_name()}</FieldLabel>
            <Input
              id={`${id}-display-name`}
              value={draft.displayName}
              onChange={(event) => patch({ displayName: event.target.value })}
              autoFocus={autoFocusDisplayName}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-type`}>{m.admin_model_type()}</FieldLabel>
            <Select
              value={draft.type}
              onValueChange={(value) => {
                if (!value) return;
                const type = value as ModelType;
                const family = draft.imageFamily ?? imageFamilies[0]?.id ?? null;
                patch(
                  type === "image" && family && !draft.imageCapabilities
                    ? {
                        type,
                        imageFamily: family,
                        imageCapabilities: imageFamilies.find((item) => item.id === family)!
                          .defaults,
                      }
                    : { type },
                );
              }}
              items={typeItems}
            >
              <SelectTrigger id={`${id}-type`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {typeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {draft.type === "chat" && draft.format !== null ? (
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-format`}>{m.admin_model_api()}</FieldLabel>
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
              <FieldDescription>{m.admin_model_api_hint()}</FieldDescription>
            </Field>
          ) : null}
          {draft.type === "chat" || image ? (
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-description`}>
                {m.admin_model_description()} <OptionalMark />
              </FieldLabel>
              <Input
                id={`${id}-description`}
                value={draft.description}
                maxLength={MODEL_DESCRIPTION_MAX}
                placeholder={
                  image
                    ? m.admin_model_description_placeholder_image()
                    : m.admin_model_description_placeholder_chat()
                }
                onChange={(event) => patch({ description: event.target.value })}
              />
              <FieldDescription>
                {image
                  ? m.admin_model_description_hint_image()
                  : m.admin_model_description_hint_chat()}
              </FieldDescription>
            </Field>
          ) : null}
          {modelKey === undefined ? null : (
            <Field>
              <FieldLabel htmlFor={`${id}-model-key`}>{m.admin_model_id()}</FieldLabel>
              <Input id={`${id}-model-key`} value={modelKey} readOnly />
              <FieldDescription>{m.admin_model_id_hint()}</FieldDescription>
            </Field>
          )}
          {image ? null : (
            <Field data-invalid={contextInvalid}>
              <FieldLabel htmlFor={`${id}-context-length`}>
                {draft.type === "chat" ? m.admin_model_context_length() : m.admin_model_max_input()}{" "}
                <OptionalMark />
              </FieldLabel>
              <Input
                id={`${id}-context-length`}
                type="number"
                min={1}
                step={1}
                value={draft.contextLength}
                onChange={(event) => patch({ contextLength: event.target.value })}
                placeholder={m.admin_model_unknown()}
                aria-invalid={contextInvalid}
              />
              {draft.type === "chat" ? (
                <FieldDescription>{m.admin_model_context_hint()}</FieldDescription>
              ) : null}
            </Field>
          )}
          {draft.type === "embedding" ? (
            <Field data-invalid={dimensionsInvalid}>
              <FieldLabel htmlFor={`${id}-embedding-dimensions`}>
                {m.admin_model_dimensions()} <OptionalMark />
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id={`${id}-embedding-dimensions`}
                  type="number"
                  min={1}
                  step={1}
                  value={draft.embeddingDimensions}
                  onChange={(event) => patch({ embeddingDimensions: event.target.value })}
                  placeholder={m.admin_model_provider_default()}
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
                            error instanceof Error ? error.message : m.admin_model_error_detect(),
                          ),
                        )
                        .finally(() => setDetecting(false));
                    }}
                  >
                    {m.admin_model_detect()}
                  </PendingButton>
                ) : null}
              </div>
              {detectError ? <FieldError>{detectError}</FieldError> : null}
              <FieldDescription>{m.admin_model_dimensions_hint()}</FieldDescription>
            </Field>
          ) : null}
        </div>
        <FieldLabel htmlFor={`${id}-enabled`}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle id={`${id}-enabled-title`}>{m.admin_model_enabled()}</FieldTitle>
              <FieldDescription>{m.admin_model_enabled_hint()}</FieldDescription>
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

      {image ? (
        <ImageModelFields
          draft={draft}
          patch={patch}
          families={imageFamilies}
          disabled={disabled}
        />
      ) : null}

      {image ? null : (
        <FieldSet compact disabled={disabled}>
          <FieldLegend variant="label">{m.admin_model_capabilities()}</FieldLegend>
          {draft.type === "embedding" ? (
            <FieldDescription>{m.admin_model_multimodal_hint()}</FieldDescription>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            {visibleCapabilities.map((capability) => {
              const label =
                draft.type === "embedding" ? m.admin_model_image_input() : capability.label();
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
              <FieldTitle>{m.admin_model_efforts()}</FieldTitle>
              <FieldDescription>{m.admin_model_efforts_hint()}</FieldDescription>
              <ToggleGroup
                multiple
                variant="choice"
                size="sm"
                className="flex-wrap"
                aria-label={m.admin_model_efforts_label()}
                value={[...(draft.capabilities.reasoningEfforts ?? [])]}
                onValueChange={(values) =>
                  setDraft((current) => ({
                    ...current,
                    capabilities: {
                      ...current.capabilities,
                      reasoningEfforts: REASONING_EFFORTS.filter((effort) =>
                        values.includes(effort),
                      ),
                    },
                  }))
                }
              >
                {REASONING_EFFORTS.map((effort) => (
                  <ToggleGroupItem key={effort} value={effort}>
                    {m.admin_model_effort({ effort })}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          ) : null}
        </FieldSet>
      )}

      {image ? null : (
        <FieldSet compact disabled={disabled}>
          <FieldLegend variant="label">
            {m.admin_model_pricing()} <OptionalMark />
          </FieldLegend>
          <FieldDescription>{m.admin_model_pricing_hint()}</FieldDescription>
          <div className="grid grid-cols-2 gap-3">
            <Field data-invalid={inputPriceInvalid || partialChatPricing}>
              <FieldLabel htmlFor={`${id}-input-price`}>{m.admin_model_price_input()}</FieldLabel>
              <Input
                id={`${id}-input-price`}
                inputMode="decimal"
                value={draft.inputPrice}
                onChange={(event) => patch({ inputPrice: event.target.value })}
                placeholder={m.admin_model_unknown()}
                aria-invalid={inputPriceInvalid || partialChatPricing}
              />
            </Field>
            {draft.type === "chat" ? (
              <Field data-invalid={outputPriceInvalid || partialChatPricing}>
                <FieldLabel htmlFor={`${id}-output-price`}>
                  {m.admin_model_price_output()}
                </FieldLabel>
                <Input
                  id={`${id}-output-price`}
                  inputMode="decimal"
                  value={draft.outputPrice}
                  onChange={(event) => patch({ outputPrice: event.target.value })}
                  placeholder={m.admin_model_unknown()}
                  aria-invalid={outputPriceInvalid || partialChatPricing}
                />
              </Field>
            ) : null}
            {draft.type === "chat" ? (
              <>
                <Field data-invalid={cacheReadInvalid}>
                  <FieldLabel htmlFor={`${id}-cache-read-price`}>
                    {m.admin_model_price_cache_read()}
                  </FieldLabel>
                  <Input
                    id={`${id}-cache-read-price`}
                    inputMode="decimal"
                    value={draft.cacheReadPrice}
                    onChange={(event) => patch({ cacheReadPrice: event.target.value })}
                    placeholder={m.admin_model_price_input_placeholder()}
                    aria-invalid={cacheReadInvalid}
                  />
                </Field>
                <Field data-invalid={cacheWriteInvalid}>
                  <FieldLabel htmlFor={`${id}-cache-write-price`}>
                    {m.admin_model_price_cache_write()}
                  </FieldLabel>
                  <Input
                    id={`${id}-cache-write-price`}
                    inputMode="decimal"
                    value={draft.cacheWritePrice}
                    onChange={(event) => patch({ cacheWritePrice: event.target.value })}
                    placeholder={m.admin_model_price_input_placeholder()}
                    aria-invalid={cacheWriteInvalid}
                  />
                </Field>
              </>
            ) : null}
          </div>
        </FieldSet>
      )}

      <FieldSet compact disabled={disabled}>
        <FieldLegend variant="label">{m.admin_model_access()}</FieldLegend>
        <Field>
          <FieldLabel htmlFor={`${id}-access`}>{m.admin_model_visibility()}</FieldLabel>
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
              ? m.admin_model_visibility_public()
              : m.admin_model_visibility_groups()}
          </FieldDescription>
        </Field>
        {draft.access === "groups" ? (
          <Field>
            <FieldLabel htmlFor={`${id}-groups`}>{m.admin_model_allowed_groups()}</FieldLabel>
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
                        placeholder={value.length ? "" : m.admin_model_add_groups()}
                      />
                    </>
                  )}
                </ComboboxValue>
              </ComboboxChips>
              <ComboboxContent anchor={groupAnchor} side="bottom">
                <ComboboxEmpty>
                  {groups.length === 0
                    ? m.admin_model_no_groups()
                    : m.admin_model_no_groups_match()}
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
              <FieldDescription>{m.admin_model_admins_only()}</FieldDescription>
            ) : null}
          </Field>
        ) : null}
      </FieldSet>
    </>
  );
}
