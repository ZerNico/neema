import type { IntegrationField } from "./manifest.ts";
import { parseMailbox } from "./mailbox.ts";

const MAX_LENGTH = 2_000;

/** Whether a field applies, given what the rest of the form holds. */
export const fieldShown = (
  field: Pick<IntegrationField, "when">,
  values: Readonly<Record<string, string>>,
) => !field.when || field.when.values.includes(values[field.when.key] ?? "");

/** A form's starting values: what is stored, else each select's first choice. */
export const fieldDefaults = (
  fields: ReadonlyArray<IntegrationField>,
  stored: Readonly<Record<string, string>>,
) => {
  const values: Record<string, string> = { ...stored };
  for (const field of fields)
    if (field.kind === "select" && !values[field.key] && field.options?.[0])
      values[field.key] = field.options[0].value;
  return values;
};

/**
 * What a person typed into a declared form, trimmed and checked by kind, or
 * the first thing wrong with it. Keys the form does not declare are dropped,
 * so nothing undeclared reaches the adapter or the stored credential.
 */
export const readFields = (
  fields: ReadonlyArray<IntegrationField>,
  input: Readonly<Record<string, string>>,
): { values: Record<string, string> } | { error: string } => {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const raw = (input[field.key] ?? "").trim();
    if (!raw) {
      if (field.required) return { error: `Enter the ${field.label}.` };
      continue;
    }
    if (raw.length > MAX_LENGTH) return { error: `The ${field.label} is too long.` };
    if (field.kind === "email") {
      const address = parseMailbox(raw);
      if (!address) return { error: `The ${field.label} is not an email address.` };
      values[field.key] = address;
    } else if (field.kind === "url") {
      if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol))
        return { error: `The ${field.label} is not a web address.` };
      values[field.key] = raw;
    } else if (field.kind === "select") {
      if (!field.options?.some((option) => option.value === raw))
        return { error: `Choose one of the ${field.label} options.` };
      values[field.key] = raw;
    } else values[field.key] = raw;
  }
  return { values };
};
