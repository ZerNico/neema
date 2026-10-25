import { Schema } from "effect";
import { locales } from "~/paraglide/runtime.js";

export const Locale = Schema.Literals(locales);

/** A person's language: theirs, or null to follow the browser. */
export const LanguageChoice = Schema.NullOr(Locale);
export type LanguageChoice = typeof LanguageChoice.Type;

export interface LanguageSetting {
  chosen: LanguageChoice;
}
