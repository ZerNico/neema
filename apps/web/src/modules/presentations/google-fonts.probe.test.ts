import { describe, expect, it } from "vitest";
import { GOOGLE_FONT_FAMILIES, googleFontsCssUrl, parseGoogleFontsCss } from "./google-fonts.ts";
import { readFontFile } from "./server/font-file.ts";

/**
 * Catches catalogue drift against live Google: every family must answer with
 * TrueType faces that call themselves by the catalogue's name, as the fetch
 * path requires. Network-bound, so it runs only on request:
 * PROBE_GOOGLE_FONTS=1 pnpm vitest run --project unit google-fonts.probe
 */
describe.skipIf(!process.env.PROBE_GOOGLE_FONTS)("the live Google catalogue", () => {
  it.each(GOOGLE_FONT_FAMILIES)("serves %s as usable TrueType faces", async (family) => {
    const css = await (await fetch(googleFontsCssUrl(family))).text();
    const files = parseGoogleFontsCss(css);
    expect(files.some((file) => !file.bold && !file.italic)).toBe(true);
    for (const file of files) {
      // oxlint-disable-next-line no-await-in-loop -- a few files, read in order
      const bytes = new Uint8Array(await (await fetch(file.url)).arrayBuffer());
      const info = readFontFile(bytes);
      expect({
        family: info.family,
        bold: info.bold,
        italic: info.italic,
        format: info.format,
      }).toEqual({ family, bold: file.bold, italic: file.italic, format: "ttf" });
    }
  });
});
