import { createFormHook, createFormHookContexts } from "@tanstack/react-form";
import type { ComponentProps } from "react";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Textarea } from "~/ui/primitives/textarea";

export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts();

function TextField({
  label,
  description,
  type = "text",
  placeholder,
  autoComplete,
}: {
  label: string;
  description?: string;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  const field = useFieldContext<string>();
  const showError = field.state.meta.isTouched && !field.state.meta.isValid;
  return (
    <Field data-invalid={showError || undefined}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Input
        id={field.name}
        name={field.name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        aria-invalid={showError || undefined}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {showError ? (
        <FieldError
          errors={field.state.meta.errors.map((e) => ({
            message: typeof e === "string" ? e : (e?.message ?? "Invalid"),
          }))}
        />
      ) : null}
    </Field>
  );
}

function TextareaField({
  label,
  description,
  placeholder,
  rows = 4,
  disabled = false,
}: {
  label: string;
  description?: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  const field = useFieldContext<string>();
  const showError = field.state.meta.isTouched && !field.state.meta.isValid;
  return (
    <Field data-invalid={showError || undefined}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Textarea
        id={field.name}
        name={field.name}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
        aria-invalid={showError || undefined}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {showError ? (
        <FieldError
          errors={field.state.meta.errors.map((error) => ({
            message: typeof error === "string" ? error : (error?.message ?? "Invalid"),
          }))}
        />
      ) : null}
    </Field>
  );
}

// Submit button wired to the form's canSubmit/isSubmitting. The pending
// presentation itself lives in PendingButton, shared with the mutations that
// have no form to subscribe to.
function SubmitButton({
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

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField, TextareaField },
  formComponents: { SubmitButton },
});
