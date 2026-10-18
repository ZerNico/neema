import { FieldSet } from "~/ui/field-set.tsx";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Field, FieldLabel, FieldLegend } from "~/ui/primitives/field";
import { MCP_SCOPE_LABELS, type McpScope } from "../scopes.ts";

/** Scopes as checkboxes, what may only be seen apart from what may be changed. */
export function ScopePicker({
  idPrefix,
  scopes,
  picked,
  onChange,
  disabled = false,
}: {
  idPrefix: string;
  scopes: ReadonlyArray<McpScope>;
  picked: ReadonlyArray<McpScope>;
  onChange: (next: ReadonlyArray<McpScope>) => void;
  disabled?: boolean;
}) {
  const group = (legend: string, members: ReadonlyArray<McpScope>) =>
    members.length ? (
      <FieldSet compact disabled={disabled}>
        <FieldLegend variant="label">{legend}</FieldLegend>
        {members.map((scope) => {
          const id = `${idPrefix}-${scope}`;
          return (
            <Field key={scope} orientation="horizontal">
              <Checkbox
                id={id}
                // Base UI labels its hidden input; the visible control
                // takes its name from the text beside it, once.
                aria-labelledby={`${id}-label`}
                checked={picked.includes(scope)}
                onCheckedChange={(on) =>
                  onChange(on ? [...picked, scope] : picked.filter((value) => value !== scope))
                }
              />
              <FieldLabel id={`${id}-label`} htmlFor={id}>
                {MCP_SCOPE_LABELS[scope]}
              </FieldLabel>
            </Field>
          );
        })}
      </FieldSet>
    ) : null;
  return (
    <>
      {group(
        "Can see",
        scopes.filter((scope) => !scope.endsWith(":write")),
      )}
      {group(
        "Can change",
        scopes.filter((scope) => scope.endsWith(":write")),
      )}
    </>
  );
}
