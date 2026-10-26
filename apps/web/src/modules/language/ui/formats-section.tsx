import { useMutation, useQuery } from "@tanstack/react-query";
import { readDesktopChannel } from "@chat/desktop-rpc";
import { detectedRegion, formatLocale, formatTag } from "~/i18n/formats.ts";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { languageQuery, pickRegion } from "../client/language.ts";

// Regions people pick formats from. Only those the page's language pairs with
// are offered: English writes any of them, German only its own.
const REGIONS = [
  "US",
  "GB",
  "IE",
  "CA",
  "AU",
  "NZ",
  "IN",
  "ZA",
  "SG",
  "DE",
  "AT",
  "CH",
  "LI",
  "LU",
  "BE",
  "NL",
  "FR",
  "IT",
  "ES",
  "PT",
  "DK",
  "SE",
  "NO",
  "FI",
  "PL",
  "CZ",
];

const AUTOMATIC = "automatic";

// A fixed moment and amount, so the preview shows the format rather than the time.
const SAMPLE_DATE = new Date(2026, 9, 26, 14, 5);
const SAMPLE_NUMBER = 1234.5;

const sample = (tag: string) =>
  `${new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(SAMPLE_DATE)} · ${new Intl.NumberFormat(tag, { minimumFractionDigits: 2 }).format(SAMPLE_NUMBER)}`;

/** How dates, times and numbers read: the system's or browser's region, or one picked. */
export function FormatsSection() {
  const setting = useQuery(languageQuery);
  const change = useMutation({
    mutationFn: pickRegion,
    onError: (error) => toastError(m.language_formats_error_save(), error),
  });
  const language = getLocale();
  const regionName = new Intl.DisplayNames([language], { type: "region" });
  const detected = detectedRegion();
  const chosen = setting.data?.region ?? null;
  const offered = [...new Set([...REGIONS, ...(chosen ? [chosen] : [])])]
    .filter((region) => formatTag(language, region) === `${language}-${region}`)
    .map((region) => ({ value: region, label: regionName.of(region) ?? region }))
    .toSorted((a, b) => a.label.localeCompare(b.label, language));
  const items = [{ value: AUTOMATIC, label: m.language_automatic() }, ...offered];
  const from = readDesktopChannel()?.systemLocale
    ? m.language_formats_automatic_system
    : m.language_formats_automatic_browser;
  return (
    <Section title={m.language_formats_title()}>
      <ListCard>
        <ListRow className="flex-wrap">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{sample(formatLocale())}</span>
            {setting.data && !chosen ? (
              <span className="text-muted-foreground text-xs">
                {detected ? from({ region: regionName.of(detected) ?? detected }) : null}
              </span>
            ) : null}
          </div>
          <Select
            value={setting.data ? (chosen ?? AUTOMATIC) : null}
            items={items}
            disabled={!setting.data || change.isPending}
            onValueChange={(value) => {
              if (value) change.mutate(value === AUTOMATIC ? null : value);
            }}
          >
            <SelectTrigger aria-label={m.language_formats_region()} className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ListRow>
      </ListCard>
    </Section>
  );
}
