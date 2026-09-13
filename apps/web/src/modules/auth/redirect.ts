/**
 * The `redirect` search param on the sign-in pages. Only a path on this origin
 * is honoured: `//host`, schemes and backslashes would all send a fresh session
 * somewhere else, and the URL parser is the last word on what a browser would do.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) return undefined;
  for (const char of value) if (char.charCodeAt(0) < 0x20) return undefined;
  try {
    const parsed = new URL(value, "http://relative.invalid");
    if (parsed.origin !== "http://relative.invalid") return undefined;
  } catch {
    return undefined;
  }
  return value;
}

/** A `/login` search object that carries the redirect only when there is one. */
export const redirectSearch = (redirect: string | undefined) => (redirect ? { redirect } : {});
