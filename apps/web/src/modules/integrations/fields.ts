import type { IntegrationField } from "./manifest.ts";
import { parseMailbox } from "./mailbox.ts";

const MAX_LENGTH = 2_000;

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
    } else values[field.key] = raw;
  }
  return { values };
};
