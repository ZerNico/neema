import { Schema } from "effect";
import { baseLocale, type Locale } from "~/paraglide/runtime.js";

/**
 * Words for a person, rendered in their locale only where they are shown. Server
 * code builds these instead of strings: it runs on fibers that do not carry the
 * request, so it cannot know the locale itself. See docs/internals/i18n.md.
 */
export type Localized = (locale: Locale) => string;

export const Localized = Schema.declare(
  (input: unknown): input is Localized => typeof input === "function",
);

type Message<Inputs> = (inputs: Inputs, options: { locale: Locale }) => string;

/** A message, with its inputs, to be rendered later in whichever locale reads it. */
export function localized(message: Message<Record<string, never>>): Localized;
export function localized<Inputs>(message: Message<Inputs>, inputs: Inputs): Localized;
export function localized<Inputs>(message: Message<Inputs>, inputs?: Inputs): Localized {
  return (locale) => message(inputs ?? ({} as Inputs), { locale });
}

/** Text that reads the same in every locale: a name, a model's own words, a wire contract. */
export const verbatim =
  (text: string): Localized =>
  () =>
    text;

/** The English rendering, for logs and for the model, which reads English throughout. */
export const english = (text: Localized) => text(baseLocale);
