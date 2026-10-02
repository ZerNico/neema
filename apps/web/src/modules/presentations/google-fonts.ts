/**
 * Free Google families a deck may use, fetched on first use. Curated rather
 * than open: the list bounds what the cache can hold, and every entry is
 * licensed (OFL or Apache) for embedding in the decks we deliver.
 */
export const GOOGLE_FONT_FAMILIES = [
  // Sans
  "Inter",
  "Poppins",
  "Montserrat",
  "Lato",
  "Open Sans",
  "Roboto",
  "Raleway",
  "Nunito",
  "Mulish",
  "Work Sans",
  "DM Sans",
  "Manrope",
  "Plus Jakarta Sans",
  "Outfit",
  "Rubik",
  "Karla",
  "Quicksand",
  "Figtree",
  "Source Sans 3",
  "IBM Plex Sans",
  "Space Grotesk",
  "Noto Sans",
  // Serif
  "Playfair Display",
  "Merriweather",
  "Lora",
  "Source Serif 4",
  "DM Serif Display",
  "Libre Baskerville",
  "EB Garamond",
  "Crimson Pro",
  "Fraunces",
  "Roboto Slab",
  "Noto Serif",
  // Display
  "Bebas Neue",
  "Oswald",
  "Archivo",
  "Barlow",
  "Josefin Sans",
  "Abril Fatface",
  // Mono
  "JetBrains Mono",
  "IBM Plex Mono",
  "Space Mono",
] as const;

export type GoogleFontFamily = (typeof GOOGLE_FONT_FAMILIES)[number];

const byName = new Map<string, GoogleFontFamily>(
  GOOGLE_FONT_FAMILIES.map((family) => [family.toLowerCase(), family]),
);

/** The catalogue spelling of a family a model named, or null when it is not one of ours. */
export const googleFontFamily = (name: string): GoogleFontFamily | null =>
  byName.get(name.trim().toLowerCase()) ?? null;

/** The four styles a deck can ask for; weights between them are not offered. */
export const googleFontsCssUrl = (family: GoogleFontFamily) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replaceAll("%20", "+")}:ital,wght@0,400;0,700;1,400;1,700`;

export interface GoogleFontFile {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly url: string;
}

/**
 * The face files a CSS2 response names. Without a browser user agent Google
 * answers with one static TrueType file per style; a style the family lacks
 * is simply absent. Any URL off fonts.gstatic.com is refused, so the response
 * can never point the server elsewhere.
 */
export function parseGoogleFontsCss(css: string): GoogleFontFile[] {
  const files: GoogleFontFile[] = [];
  for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const style = /font-style:\s*(normal|italic)\s*;/.exec(block)?.[1];
    const weight = /font-weight:\s*(\d+)\s*;/.exec(block)?.[1];
    const source = /src:\s*url\(([^)]+)\)\s*format\(['"]truetype['"]\)/.exec(block)?.[1];
    if (!style || (weight !== "400" && weight !== "700") || !source) continue;
    let url: URL;
    try {
      url = new URL(source.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== "fonts.gstatic.com" || url.port) continue;
    files.push({ bold: weight === "700", italic: style === "italic", url: url.href });
  }
  return files;
}
