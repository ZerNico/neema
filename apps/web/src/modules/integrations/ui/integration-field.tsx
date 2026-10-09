import type { ReactNode } from "react";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
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
  const options = field.options ?? [];
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {field.label} {field.required ? null : <OptionalMark />}
      </FieldLabel>
      {field.kind === "select" ? (
        <Select
          value={value || (options[0]?.value ?? "")}
          items={options}
          disabled={disabled}
          onValueChange={(next) => onChange(String(next))}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          {...INPUT[field.kind]}
          value={value}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      )}
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
      {children}
    </Field>
  );
}
