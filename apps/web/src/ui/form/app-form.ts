import { createFormHook } from "@tanstack/react-form";
import { fieldContext, formContext } from "./form-contexts.ts";
import { SubmitButton, TextField, TextareaField } from "./form-fields.tsx";

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField, TextareaField },
  formComponents: { SubmitButton },
});
