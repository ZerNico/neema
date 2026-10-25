import { m } from "~/paraglide/messages.js";
import type { Localized } from "~/i18n/localized.ts";
import type { Locale } from "~/paraglide/runtime.js";
import type { FieldCondition, IntegrationField } from "./manifest.ts";
import { parseMailbox } from "./mailbox.ts";

const MAX_LENGTH = 2_000;

/** What a field holds: one value, or each of a `choices` field's. */
export const fieldValues = (value: string | undefined) => (value ?? "").split(" ");

/**
 * Whether a field applies, given what the rest of the form holds. A hidden
 * field's value is a leftover, so a condition on it does not hold.
 */
export const fieldShown = (
  field: Pick<IntegrationField, "when">,
  values: Readonly<Record<string, string>>,
  fields: ReadonlyArray<IntegrationField> = [],
): boolean => {
  if (!field.when) return true;
  const any: ReadonlyArray<FieldCondition> = "key" in field.when ? [field.when] : field.when;
  return any.some((condition) => {
    const named = fields.find((candidate) => candidate.key === condition.key);
    if (named && !fieldShown(named, values, fields)) return false;
    return fieldValues(values[condition.key]).some((value) => condition.values.includes(value));
  });
};

/** A form's starting values: what is stored, else each choice's first option. */
export const fieldDefaults = (
  fields: ReadonlyArray<IntegrationField>,
  stored: Readonly<Record<string, string>>,
) => {
  const values: Record<string, string> = { ...stored };
  for (const field of fields)
    if (
      (field.kind === "choice" || field.kind === "choices") &&
      !values[field.key] &&
      field.options?.[0]
    )
      values[field.key] = field.options[0].value;
  return values;
};

type FieldMessage = (inputs: { field: string }, options: { locale: Locale }) => string;

/** What is wrong with a field, named by its label in whichever locale reads it. */
const about =
  (message: FieldMessage, field: IntegrationField): Localized =>
  (locale) =>
    message({ field: field.label(locale) }, { locale });

/**
 * What a person typed into a declared form, trimmed and checked by kind, or
 * the first thing wrong with it. Keys the form does not declare are dropped,
 * so nothing undeclared reaches the adapter or the stored credential.
 */
export const readFields = (
  fields: ReadonlyArray<IntegrationField>,
  input: Readonly<Record<string, string>>,
): { values: Record<string, string> } | { error: Localized } => {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const raw = (input[field.key] ?? "").trim();
    if (!raw) {
      if (field.required) return { error: about(m.integrations_field_required, field) };
      continue;
    }
    if (raw.length > MAX_LENGTH) return { error: about(m.integrations_field_too_long, field) };
    if (field.kind === "email") {
      const address = parseMailbox(raw);
      if (!address) return { error: about(m.integrations_field_not_email, field) };
      values[field.key] = address;
    } else if (field.kind === "url") {
      if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol))
        return { error: about(m.integrations_field_not_url, field) };
      values[field.key] = raw;
    } else if (field.kind === "choice") {
      if (!field.options?.some((option) => option.value === raw))
        return { error: about(m.integrations_field_choose_one, field) };
      values[field.key] = raw;
    } else if (field.kind === "choices") {
      const picked = raw.split(/\s+/);
      const options = field.options ?? [];
      if (!picked.every((value) => options.some((option) => option.value === value)))
        return { error: about(m.integrations_field_choose_from, field) };
      values[field.key] = options
        .filter((option) => picked.includes(option.value))
        .map((option) => option.value)
        .join(" ");
    } else values[field.key] = raw;
  }
  return { values };
};
