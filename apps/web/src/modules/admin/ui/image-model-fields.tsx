import { useId } from "react";
import {
  ASPECT_RATIOS,
  IMAGE_QUALITIES,
  imageFamily,
  type ImageCapabilities,
  type ImageFamily,
  type ImageFamilyInfo,
} from "@chat/model-client/image-families";
import { FieldSet } from "~/ui/field-set.tsx";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
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
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import {
  parsePrice,
  shownImagePrices,
  type ImagePriceKey,
  type ModelSettingsDraft,
} from "./model-settings-draft.ts";
import { m } from "~/paraglide/messages.js";

/**
 * The family is how the model is called; what it may do is clipped to the
 * family's limits, so the controls offer nothing the family cannot do.
 */
export function ImageModelFields({
  draft,
  patch,
  families,
  disabled = false,
}: {
  draft: ModelSettingsDraft;
  patch: (next: Partial<ModelSettingsDraft>) => void;
  families: ReadonlyArray<ImageFamilyInfo>;
  disabled?: boolean;
}) {
  const id = useId();
  const family = draft.imageFamily ? imageFamily(draft.imageFamily) : null;
  const caps = draft.imageCapabilities;
  const limits = family?.limits;
  const setCaps = (next: Partial<ImageCapabilities>) => {
    if (!caps) return;
    const merged = { ...caps, ...next };
    patch({
      imageCapabilities: merged,
      imagePrices: shownImagePrices(draft.imagePrices, merged.qualities, merged.edit !== null),
    });
  };
  const price = (
    key: ImagePriceKey,
    label: string,
    placeholder: string = m.admin_image_not_set(),
  ) => {
    const invalid =
      draft.imagePrices[key].trim() !== "" && parsePrice(draft.imagePrices[key]) === undefined;
    return (
      <Field key={key} data-invalid={invalid}>
        <FieldLabel htmlFor={`${id}-price-${key}`}>{label}</FieldLabel>
        <Input
          id={`${id}-price-${key}`}
          inputMode="decimal"
          value={draft.imagePrices[key]}
          placeholder={placeholder}
          aria-invalid={invalid}
          onChange={(event) =>
            patch({ imagePrices: { ...draft.imagePrices, [key]: event.target.value } })
          }
        />
      </Field>
    );
  };

  return (
    <>
      <FieldSet compact disabled={disabled}>
        <FieldLegend variant="label">{m.admin_image_generation()}</FieldLegend>
        <Field>
          <FieldLabel htmlFor={`${id}-family`}>{m.admin_image_family()}</FieldLabel>
          <Select
            value={draft.imageFamily}
            onValueChange={(value) => {
              if (!value) return;
              const next = imageFamily(value as ImageFamily);
              patch({
                imageFamily: next.id,
                imageCapabilities: next.defaults,
                imagePrices: shownImagePrices(
                  draft.imagePrices,
                  next.defaults.qualities,
                  next.defaults.edit !== null,
                ),
              });
            }}
            items={families.map((item) => ({ value: item.id, label: item.label }))}
          >
            <SelectTrigger id={`${id}-family`} className="w-full">
              <SelectValue placeholder={m.admin_image_family_placeholder()} />
            </SelectTrigger>
            <SelectContent>
              {families.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{m.admin_image_family_hint()}</FieldDescription>
        </Field>
        {caps && limits ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <FieldLabel htmlFor={`${id}-generate`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle id={`${id}-generate-title`}>{m.admin_image_generate()}</FieldTitle>
                  </FieldContent>
                  <Switch
                    id={`${id}-generate`}
                    aria-labelledby={`${id}-generate-title`}
                    checked={caps.generate}
                    disabled={!limits.generate}
                    onCheckedChange={(generate) => setCaps({ generate })}
                  />
                </Field>
              </FieldLabel>
              <FieldLabel htmlFor={`${id}-transparency`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle id={`${id}-transparency-title`}>
                      {m.admin_image_transparency()}
                    </FieldTitle>
                  </FieldContent>
                  <Switch
                    id={`${id}-transparency`}
                    aria-labelledby={`${id}-transparency-title`}
                    checked={caps.transparency}
                    disabled={!limits.transparency}
                    onCheckedChange={(transparency) => setCaps({ transparency })}
                  />
                </Field>
              </FieldLabel>
              <FieldLabel htmlFor={`${id}-edit`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle id={`${id}-edit-title`}>{m.admin_image_edit()}</FieldTitle>
                  </FieldContent>
                  <Switch
                    id={`${id}-edit`}
                    aria-labelledby={`${id}-edit-title`}
                    checked={caps.edit !== null}
                    disabled={!limits.edit}
                    onCheckedChange={(on) =>
                      setCaps({ edit: on && limits.edit ? { ...limits.edit } : null })
                    }
                  />
                </Field>
              </FieldLabel>
              {caps.edit && limits.edit ? (
                <FieldLabel htmlFor={`${id}-references`}>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>{m.admin_image_references()}</FieldTitle>
                    </FieldContent>
                    <Input
                      id={`${id}-references`}
                      type="number"
                      min={1}
                      max={limits.edit.maxReferences}
                      className="w-20"
                      value={caps.edit.maxReferences}
                      onChange={(event) =>
                        setCaps({
                          edit: {
                            maxReferences: Math.max(
                              1,
                              Math.min(limits.edit!.maxReferences, Number(event.target.value) || 1),
                            ),
                          },
                        })
                      }
                    />
                  </Field>
                </FieldLabel>
              ) : null}
            </div>
            <Field>
              <FieldTitle>{m.admin_image_aspect_ratios()}</FieldTitle>
              <ToggleGroup
                multiple
                variant="choice"
                size="sm"
                className="flex-wrap"
                aria-label={m.admin_image_aspect_ratios()}
                value={[...caps.aspectRatios]}
                onValueChange={(values) =>
                  setCaps({ aspectRatios: ASPECT_RATIOS.filter((ratio) => values.includes(ratio)) })
                }
              >
                {limits.aspectRatios.map((ratio) => (
                  <ToggleGroupItem key={ratio} value={ratio}>
                    {ratio}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {caps.aspectRatios.length === 0 ? (
                <FieldDescription>{m.admin_image_choose_one()}</FieldDescription>
              ) : null}
            </Field>
            {limits.qualities.length > 0 ? (
              <Field>
                <FieldTitle>{m.admin_image_qualities()}</FieldTitle>
                <ToggleGroup
                  multiple
                  variant="choice"
                  size="sm"
                  aria-label={m.admin_image_qualities()}
                  value={[...caps.qualities]}
                  onValueChange={(values) =>
                    setCaps({
                      qualities: IMAGE_QUALITIES.filter((quality) => values.includes(quality)),
                    })
                  }
                >
                  {limits.qualities.map((quality) => (
                    <ToggleGroupItem key={quality} value={quality}>
                      {m.admin_image_quality({ quality })}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${id}-count`}>{m.admin_image_count()}</FieldLabel>
              <Input
                id={`${id}-count`}
                type="number"
                min={1}
                max={limits.maxCount}
                value={caps.maxCount}
                onChange={(event) =>
                  setCaps({
                    maxCount: Math.max(
                      1,
                      Math.min(limits.maxCount, Number(event.target.value) || 1),
                    ),
                  })
                }
              />
            </Field>
          </>
        ) : null}
      </FieldSet>

      <FieldSet compact disabled={disabled}>
        <FieldLegend variant="label">
          {m.admin_image_pricing()} <OptionalMark />
        </FieldLegend>
        <FieldDescription>{m.admin_image_pricing_hint()}</FieldDescription>
        <div className="grid grid-cols-3 gap-3">
          {price("textInput", m.admin_image_price_text_input())}
          {price("imageInput", m.admin_image_price_image_input())}
          {price("output", m.admin_image_price_output())}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {price("default", m.admin_image_price_default())}
          {caps?.qualities.map((quality) =>
            price(
              quality,
              m.admin_image_price_quality({ quality }),
              m.admin_image_price_default_placeholder(),
            ),
          )}
          {caps?.edit
            ? price("reference", m.admin_image_price_edit(), m.admin_image_price_none())
            : null}
        </div>
      </FieldSet>
    </>
  );
}
