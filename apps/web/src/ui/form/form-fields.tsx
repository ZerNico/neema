import { useId, type ComponentProps } from "react";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Textarea } from "~/ui/primitives/textarea";
import { useFieldContext, useFormContext } from "./form-contexts.ts";
import { m } from "~/paraglide/messages.js";

/**
 * Marks an optional field inside its label, so it is part of the accessible name. Required
 * fields carry no mark: most fields are required, so marking the exceptions is quieter.
 */
export function OptionalMark() {
  return <span className="text-muted-foreground font-normal">{m.ui_field_optional()}</span>;
}

export function TextField({
  label,
  optional = false,
  description,
  type = "text",
  placeholder,
  autoComplete,
}: {
  label: string;
  optional?: boolean;
  description?: string;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  const field = useFieldContext<string>();
  const id = useId();
  const showError = field.state.meta.isTouched && !field.state.meta.isValid;
  const errors = field.state.meta.errors
    .map((error) => ({
      message: typeof error === "string" ? error : (error?.message ?? m.ui_field_invalid()),
    }))
    .filter((error) => error.message);
  const descriptionId = description ? `${id}-help` : undefined;
  const errorId = showError && errors.length > 0 ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <Field data-invalid={showError || undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {optional ? (
          <>
            {" "}
            <OptionalMark />
          </>
        ) : null}
      </FieldLabel>
      <Input
        id={id}
        name={field.name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        aria-invalid={showError || undefined}
        aria-describedby={describedBy}
      />
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      {errorId ? <FieldError id={errorId} errors={errors} /> : null}
    </Field>
  );
}

export function TextareaField({
  label,
  optional = false,
  description,
  placeholder,
  rows = 4,
  disabled = false,
}: {
  label: string;
  optional?: boolean;
  description?: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  const field = useFieldContext<string>();
  const id = useId();
  const showError = field.state.meta.isTouched && !field.state.meta.isValid;
  const errors = field.state.meta.errors
    .map((error) => ({
      message: typeof error === "string" ? error : (error?.message ?? m.ui_field_invalid()),
    }))
    .filter((error) => error.message);
  const descriptionId = description ? `${id}-help` : undefined;
  const errorId = showError && errors.length > 0 ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <Field data-invalid={showError || undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {optional ? (
          <>
            {" "}
            <OptionalMark />
          </>
        ) : null}
      </FieldLabel>
      <Textarea
        id={id}
        name={field.name}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
        aria-invalid={showError || undefined}
        aria-describedby={describedBy}
      />
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      {errorId ? <FieldError id={errorId} errors={errors} /> : null}
    </Field>
  );
}

/**
 * Submit button wired to the form's canSubmit/isSubmitting. The pending
 * presentation itself lives in PendingButton, shared with the mutations that
 * have no form to subscribe to.
 */
export function SubmitButton({
  children,
  disabled,
  ...props
}: Omit<ComponentProps<typeof PendingButton>, "type" | "pending">) {
  const form = useFormContext();
  return (
    <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
      {([canSubmit, isSubmitting]) => (
        <PendingButton
          type="submit"
          pending={isSubmitting}
          disabled={disabled || !canSubmit}
          {...props}
        >
          {children}
        </PendingButton>
      )}
    </form.Subscribe>
  );
}
