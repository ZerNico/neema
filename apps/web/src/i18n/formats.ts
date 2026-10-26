import { readDesktopChannel } from "@chat/desktop-rpc";
import { getLocale, type Locale } from "~/paraglide/runtime.js";

/**
 * How dates, times and numbers read: the page's language written the way a
 * region writes it, "en-GB" or "de-CH". The language says which words; the
 * region says 14:05 or 2:05 PM, 26.10. or 10/26, 1.234,5 or 1,234.5. A person
 * picks the region in Settings or leaves it to the operating system (desktop
 * app) or the browser. See docs/internals/i18n.md.
 *
 * The `formats` cookie holds the region in effect, chosen or detected, and both
 * the server and the page read it, so a page rendered on the server formats
 * like the page that hydrates it.
 */
const COOKIE = "formats";
const pattern = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Z]{2})(?:;|$)`);

/** The region of a tag like "en-DE" or "en_DE", or undefined when it names none. */
export const regionOf = (tag: string | undefined) => {
  if (!tag) return undefined;
  try {
    return new Intl.Locale(tag.replace("_", "-")).region;
  } catch {
    return undefined;
  }
};

const languageOf = (tag: string) => {
  try {
    return new Intl.Locale(tag.replace("_", "-")).language;
  } catch {
    return undefined;
  }
};

/**
 * `language` written as `region` writes it, when the platform knows that pair.
 * English pairs with any region; German only with its own (DE, AT, CH, …), so
 * German formats stay German elsewhere.
 */
export const formatTag = (language: Locale, region: string | undefined) => {
  if (!region) return language;
  const tag = `${language}-${region}`;
  return new Intl.DateTimeFormat(tag).resolvedOptions().locale === tag ? tag : language;
};

/**
 * The region "Automatic" follows: the operating system's in the desktop app,
 * else the first the browser names for the page's language, else the first it
 * names at all, so a German browser reading English keeps German formats.
 */
export const detectRegion = (
  language: Locale,
  preferred: readonly string[],
  system?: string,
): string | undefined =>
  regionOf(system) ??
  preferred
    .filter((tag) => languageOf(tag) === language)
    .map(regionOf)
    .find(Boolean) ??
  preferred.map(regionOf).find(Boolean);

/** The region in a cookie header, as the page or a request sends it. */
export const regionIn = (cookies: string | null | undefined) => cookies?.match(pattern)?.[1];

/** What this device detects for "Automatic". */
export const detectedRegion = () =>
  detectRegion(getLocale(), navigator.languages, readDesktopChannel()?.systemLocale);

/** Mirrors the region in effect, so the server formats the next request the same way. */
export const rememberRegion = (region: string | undefined) => {
  document.cookie = region
    ? `${COOKIE}=${region}; path=/; max-age=31536000; samesite=lax`
    : `${COOKIE}=; path=/; max-age=0; samesite=lax`;
};

let serverRegion: () => string | undefined = () => undefined;

/** Registered by the server entry, which knows the request; the page reads its cookie. */
export const defineServerRegion = (read: () => string | undefined) => {
  serverRegion = read;
};

/**
 * The locale to hand `Intl` and `toLocale*` for anything a person reads. Never
 * the bare `getLocale()`, which formats every English reader as American.
 */
export const formatLocale = (language: Locale = getLocale()) =>
  formatTag(
    language,
    typeof document === "undefined"
      ? serverRegion()
      : (regionIn(document.cookie) ?? detectedRegion()),
  );
