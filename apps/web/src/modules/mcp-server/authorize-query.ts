/** Parameters the authorization server adds when it signs a query for a page. */
const SIGNING_PARAMS = ["sig", "exp", "ba_iat", "ba_param", "ba_pl"];

/**
 * The app's original authorization request, from a page query the server
 * signed. Asking again once signed in is what the app did in the first place,
 * so nothing here needs the signature; `prompt=login` and `max_age` are
 * dropped because by then the person has just signed in (see `needsFreshSignIn`).
 */
export function authorizeQuery(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const name of SIGNING_PARAMS) params.delete(name);
  params.delete("max_age");
  const prompt = params
    .get("prompt")
    ?.split(" ")
    .filter((value) => value && value !== "login");
  if (prompt?.length) params.set("prompt", prompt.join(" "));
  else params.delete("prompt");
  return params.toString();
}

export const AUTHORIZE_PATH = "/api/auth/oauth2/authorize";

/**
 * Whether the app asked for a sign-in newer than any existing session. The
 * provider sends someone already signed in to the login page only then, so
 * that session must end rather than satisfy the request.
 */
export function needsFreshSignIn(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return Boolean(params.get("prompt")?.split(" ").includes("login")) || params.has("max_age");
}

/**
 * A query carried through the router as one opaque value. The router parses
 * and re-serializes search: repeated keys collapse into a JSON array and
 * numeric-looking values change form, which breaks a signature or an app's
 * `state`. Base64url has none of those shapes.
 */
export const packQuery = (query: string) =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(query)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const unpackQuery = (packed: unknown): string | null => {
  if (typeof packed !== "string" || !/^[\w-]+$/.test(packed)) return null;
  try {
    const binary = atob(packed.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.codePointAt(0)!));
  } catch {
    return null;
  }
};
