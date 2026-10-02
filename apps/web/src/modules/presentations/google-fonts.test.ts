import { describe, expect, it } from "vitest";
import { googleFontFamily, googleFontsCssUrl, parseGoogleFontsCss } from "./google-fonts.ts";

const block = (style: string, weight: number, url: string) =>
  `@font-face {\n  font-family: 'Poppins';\n  font-style: ${style};\n  font-weight: ${weight};\n  src: url(${url}) format('truetype');\n}`;

describe("the Google font catalogue", () => {
  it("normalizes a model's spelling to the catalogue's and ignores other names", () => {
    expect(googleFontFamily("  plus jakarta sans ")).toBe("Plus Jakarta Sans");
    expect(googleFontFamily("Comic Sans MS")).toBeNull();
    expect(googleFontsCssUrl("Plus Jakarta Sans")).toBe(
      "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,700;1,400;1,700",
    );
  });

  it("takes only the four styles, and only files served from fonts.gstatic.com", () => {
    const css = [
      block("normal", 400, "https://fonts.gstatic.com/s/poppins/v24/regular.ttf"),
      block("italic", 700, "https://fonts.gstatic.com/s/poppins/v24/bold-italic.ttf"),
      block("normal", 600, "https://fonts.gstatic.com/s/poppins/v24/semibold.ttf"),
      block("normal", 700, "https://evil.example/bold.ttf"),
      block("italic", 400, "http://fonts.gstatic.com/s/poppins/v24/italic.ttf"),
      block("italic", 400, "https://fonts.gstatic.com:8443/s/poppins/italic.ttf"),
    ].join("\n");
    expect(parseGoogleFontsCss(css)).toEqual([
      { bold: false, italic: false, url: "https://fonts.gstatic.com/s/poppins/v24/regular.ttf" },
      { bold: true, italic: true, url: "https://fonts.gstatic.com/s/poppins/v24/bold-italic.ttf" },
    ]);
  });
});
