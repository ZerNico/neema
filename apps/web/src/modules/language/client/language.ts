import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { chosenLocale, rememberChoice } from "~/i18n/choice.ts";
import {
  baseLocale,
  extractLocaleFromNavigator,
  getLocale,
  type Locale,
} from "~/paraglide/runtime.js";
import { chooseLanguage, getLanguage, noteBrowserLanguage } from "../server/functions.ts";

export const languageQuery = queryOptions({
  queryKey: ["language"],
  queryFn: () => getLanguage(),
  staleTime: Infinity,
});

/** The language the browser asks for, which "Automatic" follows. */
export const browserLocale = () => extractLocaleFromNavigator() ?? baseLocale;

let browserNoted = false;

/**
 * Brings this device in line with the account's choice before anything
 * renders: a choice made on another device, or cleared there, reloads the page
 * in the right language once. Resolves only when no reload is needed.
 */
export async function alignLanguage(queryClient: QueryClient) {
  const { chosen } = await queryClient.ensureQueryData(languageQuery);
  // Read before the cookie changes: the locale resolves from it on every call.
  const showing = getLocale();
  if (chosen !== (chosenLocale() ?? null)) rememberChoice(chosen);
  if ((chosen ?? browserLocale()) !== showing) {
    location.reload();
    // The page is going; nothing below should render in the old language.
    return new Promise<never>(() => {});
  }
  if (!chosen && !browserNoted) {
    browserNoted = true;
    void noteBrowserLanguage({ data: { browser: getLocale() } }).catch(() => {});
  }
}

/** Saves the choice to the account and reloads the app in it. */
export async function choose(chosen: Locale | null) {
  await chooseLanguage({ data: { chosen } });
  rememberChoice(chosen);
  location.reload();
}
