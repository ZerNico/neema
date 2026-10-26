import { Schema } from "effect";
import { locales } from "~/paraglide/runtime.js";

export const Locale = Schema.Literals(locales);

/** A person's language: theirs, or null to follow the browser. */
export const LanguageChoice = Schema.NullOr(Locale);
export type LanguageChoice = typeof LanguageChoice.Type;

/** A region's two letters ("GB"), whose way of writing dates and numbers a person picked, or null. */
export const RegionChoice = Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u)));
export type RegionChoice = typeof RegionChoice.Type;

export interface LanguageSetting {
  chosen: LanguageChoice;
  region: RegionChoice;
}
