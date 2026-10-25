import type { AnyFieldApi } from "@tanstack/react-form";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { m } from "~/paraglide/messages.js";

const fieldErrors = (field: AnyFieldApi) =>
  field.state.meta.errors.map((e: unknown) => ({
    message:
      typeof e === "string"
        ? e
        : ((e as { message?: string } | undefined)?.message ?? m.tools_field_invalid()),
  }));

/** Number input with min/max, since TextField only covers text-like controls. */
export function NumberField({
  field,
  label,
  description,
  min,
  max,
  step,
  className,
}: {
  field: AnyFieldApi;
  label: string;
  description?: string;
  min: number;
  max: number;
  step?: number;
  className?: string;
}) {
  const showError = field.state.meta.errors.length > 0;
  return (
    <Field className={className} data-invalid={showError || undefined}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Input
        id={field.name}
        name={field.name}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        aria-invalid={showError || undefined}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {showError ? <FieldError errors={fieldErrors(field)} /> : null}
    </Field>
  );
}
