// Landing-page greeting. Better Auth's `name` is free-form text (a full name,
// a single handle, sometimes an email), so the greeting only uses it when the
// leading word actually reads like something to call a person.

const NEUTRAL = "What can I help with?";

/** Leading word of a display name, or null when it wouldn't read as a name. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  // An address or a long identifier greets the account, not the person.
  if (!first || first.includes("@") || first.length > 24) return null;
  return first;
}

export function greetingFor(name: string | null | undefined): string {
  const first = firstNameOf(name);
  return first === null ? NEUTRAL : `What can I help with, ${first}?`;
}
