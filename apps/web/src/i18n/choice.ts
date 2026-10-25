import {
  defineCustomClientStrategy,
  defineCustomServerStrategy,
  getLocale,
  isLocale,
  type Locale,
} from "~/paraglide/runtime.js";

/**
 * A language the person chose, mirrored from their account into a cookie so
 * the first frame and every request read it without asking the server. With
 * no choice there is no cookie and the browser's language decides, on the page
 * through `navigator.languages` and on the server through `Accept-Language`.
 * Paraglide's own cookie strategy is not used: it stores whatever it first
 * detected, which would freeze "Automatic" at the language of the first visit.
 */
const COOKIE = "language";
const pattern = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`);

const chosenIn = (cookies: string | null | undefined) => {
  const value = cookies?.match(pattern)?.[1];
  return isLocale(value) ? value : undefined;
};

/** What the person chose on this device, or undefined to follow the browser. */
export const chosenLocale = () =>
  typeof document === "undefined" ? undefined : chosenIn(document.cookie);

/** Mirrors the account's choice; null forgets it, so the browser decides again. */
export const rememberChoice = (locale: Locale | null) => {
  // A year, renewed whenever the account's choice is read back.
  document.cookie = locale
    ? `${COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`
    : `${COOKIE}=; path=/; max-age=0; samesite=lax`;
};

// The `custom-chosen` strategy `paraglide.ts` names first. Registered on import,
// so the entry points import this module before anything that renders a message.
defineCustomClientStrategy("custom-chosen", {
  getLocale: chosenLocale,
  // Paraglide also writes back what it detected; only a choice is kept.
  setLocale: () => {},
});
defineCustomServerStrategy("custom-chosen", {
  getLocale: (request) => chosenIn(request?.headers.get("cookie")),
});

// The shell is built once, in English; the page says which language it is in.
if (typeof document !== "undefined") document.documentElement.lang = getLocale();
