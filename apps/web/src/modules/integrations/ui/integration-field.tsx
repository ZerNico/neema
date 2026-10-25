import { getLocale } from "~/paraglide/runtime.js";
import type { ReactNode } from "react";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { Checkbox } from "~/ui/primitives/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { RadioGroup, RadioGroupItem } from "~/ui/primitives/radio-group";
import { fieldValues } from "../fields.ts";
import type { IntegrationField } from "../manifest.ts";

const INPUT = {
  url: { type: "url", autoComplete: "url" },
  text: { type: "text", autoComplete: "off" },
  email: { type: "email", autoComplete: "email" },
  secret: { type: "password", autoComplete: "off" },
} as const;

/** One declared field, in the admin's setup or a person's API key form. */
export function IntegrationFieldControl({
  id,
  field,
  value,
  onChange,
  disabled,
  children,
}: {
  id: string;
  field: IntegrationField;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  /** More help below the field's own description. */
  children?: ReactNode;
}) {
  if (field.kind === "choice" || field.kind === "choices")
    return (
      <ChoiceField id={id} field={field} value={value} onChange={onChange} disabled={disabled}>
        {children}
      </ChoiceField>
    );
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {field.label(getLocale())} {field.required ? null : <OptionalMark />}
      </FieldLabel>
      <Input
        id={id}
        {...INPUT[field.kind]}
        value={value}
        placeholder={field.placeholder?.(getLocale())}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
      {field.description ? (
        <FieldDescription>{field.description(getLocale())}</FieldDescription>
      ) : null}
      {children}
    </Field>
  );
}

/** Few options, each with a line saying what it means, so they read better laid out than in a menu. */
function ChoiceField({
  id,
  field,
  value,
  onChange,
  disabled,
  children,
}: {
  id: string;
  field: IntegrationField;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  children?: ReactNode;
}) {
  const options = field.options ?? [];
  const picked = fieldValues(value);
  const option = (entry: (typeof options)[number], control: ReactNode) => (
    <Field key={entry.value} orientation="horizontal">
      {control}
      <FieldContent>
        <FieldLabel id={`${id}-${entry.value}-label`} htmlFor={`${id}-${entry.value}`}>
          {entry.label(getLocale())}
        </FieldLabel>
        {entry.description ? (
          <FieldDescription id={`${id}-${entry.value}-description`}>
            {entry.description(getLocale())}
          </FieldDescription>
        ) : null}
      </FieldContent>
    </Field>
  );
  // Base UI renders both controls as spans, which a label's htmlFor does not name.
  const named = (entry: (typeof options)[number]) => ({
    id: `${id}-${entry.value}`,
    "aria-labelledby": `${id}-${entry.value}-label`,
    ...(entry.description ? { "aria-describedby": `${id}-${entry.value}-description` } : {}),
  });
  return (
    <FieldSet disabled={disabled}>
      <FieldLegend variant="label">
        {field.label(getLocale())} {field.required ? null : <OptionalMark />}
      </FieldLegend>
      {field.kind === "choice" ? (
        <RadioGroup
          value={value || (options[0]?.value ?? "")}
          disabled={disabled}
          onValueChange={(next) => onChange(String(next))}
        >
          {options.map((entry) =>
            option(entry, <RadioGroupItem value={entry.value} {...named(entry)} />),
          )}
        </RadioGroup>
      ) : (
        <FieldGroup data-slot="checkbox-group">
          {options.map((entry) =>
            option(
              entry,
              <Checkbox
                checked={picked.includes(entry.value)}
                disabled={disabled}
                onCheckedChange={(on) =>
                  onChange(
                    options
                      .filter((other) =>
                        other.value === entry.value ? on : picked.includes(other.value),
                      )
                      .map((other) => other.value)
                      .join(" "),
                  )
                }
                {...named(entry)}
              />,
            ),
          )}
        </FieldGroup>
      )}
      {field.description ? (
        <FieldDescription>{field.description(getLocale())}</FieldDescription>
      ) : null}
      {children}
    </FieldSet>
  );
}
