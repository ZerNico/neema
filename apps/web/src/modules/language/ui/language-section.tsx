import { useMutation, useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { m } from "~/paraglide/messages.js";
import { isLocale, type Locale, locales } from "~/paraglide/runtime.js";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, Section } from "~/ui/page-shell.tsx";
import { RadioGroup, RadioGroupItem } from "~/ui/primitives/radio-group";
import { browserLocale, choose, languageQuery } from "../client/language.ts";

/** A language named in itself, as a person looking for theirs would read it. */
const endonym = (locale: Locale) =>
  new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;

const AUTOMATIC = "automatic";

/** The account's language: the browser's, or one the person picks. */
export function LanguageSection() {
  const id = useId();
  const setting = useQuery(languageQuery);
  const change = useMutation({
    mutationFn: choose,
    onError: (error) => toastError(m.language_error_save(), error),
  });
  const options = [
    {
      value: AUTOMATIC,
      title: m.language_automatic(),
      description: m.language_automatic_description({ language: endonym(browserLocale()) }),
    },
    ...locales.map((locale) => ({ value: locale, title: endonym(locale), description: null })),
  ];
  return (
    <Section title={m.language_title()}>
      <ListCard>
        <RadioGroup
          variant="list"
          aria-label={m.language_title()}
          value={setting.data ? (setting.data.chosen ?? AUTOMATIC) : null}
          disabled={!setting.data || change.isPending}
          onValueChange={(value) => change.mutate(isLocale(value) ? value : null)}
        >
          {options.map((option) => (
            <label
              key={option.value}
              className="hover:bg-accent/50 flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors"
            >
              <RadioGroupItem
                value={option.value}
                aria-labelledby={`${id}-${option.value}`}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                {/* Each language in its own words, read with its own pronunciation. */}
                <span
                  id={`${id}-${option.value}`}
                  lang={option.value === AUTOMATIC ? undefined : option.value}
                  className="text-sm font-medium"
                >
                  {option.title}
                </span>
                {option.description ? (
                  <span className="text-muted-foreground text-xs">{option.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </RadioGroup>
      </ListCard>
    </Section>
  );
}
