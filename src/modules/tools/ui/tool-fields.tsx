import type { AnyFieldApi } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
// Number inputs are kept as strings in form state (what the <input> holds);
// the schema parses and range-checks them, so a typo shows as a field error
// instead of silently disabling Save.
export const integerBetween = (minimum: number, maximum: number) =>
  Schema.NumberFromString.check(
    Schema.isInt({ message: "Enter a whole number." }),
    Schema.isBetween({ minimum, maximum }, { message: `Between ${minimum} and ${maximum}.` }),
  );

const fieldErrors = (field: AnyFieldApi) =>
  field.state.meta.errors.map((e: unknown) => ({
    message:
      typeof e === "string" ? e : ((e as { message?: string } | undefined)?.message ?? "Invalid"),
  }));

/** Number input with min/max — TextField only covers text-like controls. */
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

export const useInvalidateTools = (availabilityKey: string) => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "tools"] }),
      queryClient.invalidateQueries({ queryKey: ["tools", availabilityKey, "availability"] }),
    ]);
};
