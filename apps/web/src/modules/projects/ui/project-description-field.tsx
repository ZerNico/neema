import { useId } from "react";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Textarea } from "~/ui/primitives/textarea";
import { PROJECT_LIMITS } from "../schema.ts";

/** A project's description, below its name in the create and rename dialogs. */
export function ProjectDescriptionField({
  value,
  onChange,
  pending,
  hint,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  pending: boolean;
  hint: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>Description</FieldLabel>
      <Textarea
        id={id}
        value={value}
        maxLength={PROJECT_LIMITS.description}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={pending}
      />
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  );
}
