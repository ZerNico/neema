/**
 * What a sheet's locale changes: separators, names and the order dates are
 * typed in. Tables of our own rather than Intl, so every browser and the
 * server write the same text for the same value. Formula syntax and
 * function names stay English in every locale.
 */
export interface SheetLocale {
  readonly id: string;
  readonly decimal: string;
  readonly group: string;
  readonly dateSeparator: string;
  readonly timeSeparator: string;
  /** How a typed date with three numbers is read, and the short date it is shown in. */
  readonly dateOrder: "MDY" | "DMY" | "YMD";
  readonly shortDate: string;
  readonly months: readonly string[];
  readonly monthsShort: readonly string[];
  readonly days: readonly string[];
  readonly daysShort: readonly string[];
  readonly am: string;
  readonly pm: string;
  /** The local currency, as a typed amount carries it and a currency format writes it. */
  readonly currency: { readonly symbol: string; readonly before: boolean; readonly lcid: string };
}

const ENGLISH_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const ENGLISH_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const short = (names: readonly string[]) => names.map((name) => name.slice(0, 3));

export const EN_US: SheetLocale = {
  id: "en-US",
  decimal: ".",
  group: ",",
  dateSeparator: "/",
  timeSeparator: ":",
  dateOrder: "MDY",
  shortDate: "m/d/yyyy",
  months: ENGLISH_MONTHS,
  monthsShort: short(ENGLISH_MONTHS),
  days: ENGLISH_DAYS,
  daysShort: short(ENGLISH_DAYS),
  am: "AM",
  pm: "PM",
  currency: { symbol: "$", before: true, lcid: "409" },
};

export const EN_GB: SheetLocale = {
  ...EN_US,
  id: "en-GB",
  dateOrder: "DMY",
  shortDate: "dd/mm/yyyy",
  currency: { symbol: "£", before: true, lcid: "809" },
};

const GERMAN_MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];
const GERMAN_DAYS = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
];
export const DE_DE: SheetLocale = {
  id: "de-DE",
  decimal: ",",
  group: ".",
  dateSeparator: ".",
  timeSeparator: ":",
  dateOrder: "DMY",
  shortDate: "dd/mm/yyyy",
  months: GERMAN_MONTHS,
  monthsShort: short(GERMAN_MONTHS),
  days: GERMAN_DAYS,
  daysShort: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
  am: "AM",
  pm: "PM",
  currency: { symbol: "€", before: false, lcid: "407" },
};

const FRENCH_MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];
export const FR_FR: SheetLocale = {
  id: "fr-FR",
  decimal: ",",
  // A narrow no-break space, as French Excel groups thousands.
  group: "\u202f",
  dateSeparator: "/",
  timeSeparator: ":",
  dateOrder: "DMY",
  shortDate: "dd/mm/yyyy",
  months: FRENCH_MONTHS,
  monthsShort: [
    "janv.",
    "févr.",
    "mars",
    "avr.",
    "mai",
    "juin",
    "juil.",
    "août",
    "sept.",
    "oct.",
    "nov.",
    "déc.",
  ],
  days: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
  daysShort: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
  am: "AM",
  pm: "PM",
  currency: { symbol: "€", before: false, lcid: "40C" },
};

export const SHEET_LOCALES: readonly SheetLocale[] = [EN_US, EN_GB, DE_DE, FR_FR];

/** The locale for a browser's language tag: an exact match, then the language, then US English. */
export const sheetLocale = (tag: string | null | undefined): SheetLocale => {
  const wanted = (tag ?? "").toLowerCase();
  return (
    SHEET_LOCALES.find((locale) => locale.id.toLowerCase() === wanted) ??
    SHEET_LOCALES.find((locale) => locale.id.slice(0, 2).toLowerCase() === wanted.slice(0, 2)) ??
    EN_US
  );
};
