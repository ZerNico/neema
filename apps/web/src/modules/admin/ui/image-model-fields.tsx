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

const QUALITY_LABELS = { low: "Low", medium: "Medium", high: "High" } as const;

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
  const price = (key: ImagePriceKey, label: string, placeholder = "Not set") => {
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
        <FieldLegend variant="label">Image generation</FieldLegend>
        <Field>
          <FieldLabel htmlFor={`${id}-family`}>Family</FieldLabel>
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
              <SelectValue placeholder="Choose a family" />
            </SelectTrigger>
            <SelectContent>
              {families.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            How the model is called. Its limits bound the settings below.
          </FieldDescription>
        </Field>
        {caps && limits ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <FieldLabel htmlFor={`${id}-generate`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle id={`${id}-generate-title`}>Creates from a prompt</FieldTitle>
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
                    <FieldTitle id={`${id}-transparency-title`}>Transparent backgrounds</FieldTitle>
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
                    <FieldTitle id={`${id}-edit-title`}>Edits images</FieldTitle>
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
                      <FieldTitle>Reference images</FieldTitle>
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
              <FieldTitle>Aspect ratios</FieldTitle>
              <ToggleGroup
                multiple
                variant="choice"
                size="sm"
                className="flex-wrap"
                aria-label="Aspect ratios"
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
                <FieldDescription>Choose at least one.</FieldDescription>
              ) : null}
            </Field>
            {limits.qualities.length > 0 ? (
              <Field>
                <FieldTitle>Quality levels</FieldTitle>
                <ToggleGroup
                  multiple
                  variant="choice"
                  size="sm"
                  aria-label="Quality levels"
                  value={[...caps.qualities]}
                  onValueChange={(values) =>
                    setCaps({
                      qualities: IMAGE_QUALITIES.filter((quality) => values.includes(quality)),
                    })
                  }
                >
                  {limits.qualities.map((quality) => (
                    <ToggleGroupItem key={quality} value={quality}>
                      {QUALITY_LABELS[quality]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${id}-count`}>Images per call</FieldLabel>
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
          Pricing <OptionalMark />
        </FieldLegend>
        <FieldDescription>USD, used when the provider doesn’t report a cost.</FieldDescription>
        <div className="grid grid-cols-3 gap-3">
          {price("textInput", "Text input $/1M")}
          {price("imageInput", "Image input $/1M")}
          {price("output", "Output $/1M")}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {price("default", "Default $/image")}
          {caps?.qualities.map((quality) =>
            price(quality, `${QUALITY_LABELS[quality]} $/image`, "Default price"),
          )}
          {caps?.edit ? price("reference", "Edit fee $/image", "None") : null}
        </div>
      </FieldSet>
    </>
  );
}
