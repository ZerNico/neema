import { describe, expect, it } from "vitest";
import type { FontFace } from "./font-file.ts";
import { deckTypefaces, facesFor, operationTypefaces } from "./font-usage.ts";

const encoder = new TextEncoder();
const face = (family: string, renderFamily = family): FontFace => ({
  family,
  renderFamily,
  bold: false,
  italic: false,
  path: `/${family}.ttf`,
  source: "google",
});

describe("the fonts a deck uses", () => {
  it("reads typefaces from the theme, slides and charts, but not theme references or other parts", () => {
    const parts = new Map([
      [
        "ppt/theme/theme1.xml",
        encoder.encode(
          '<a:majorFont><a:latin typeface="Poppins"/></a:majorFont><a:minorFont><a:latin typeface="Inter"/></a:minorFont>',
        ),
      ],
      [
        "ppt/slides/slide1.xml",
        encoder.encode('<a:rPr><a:latin typeface="+mj-lt"/><a:ea typeface="Noto Sans"/></a:rPr>'),
      ],
      ["ppt/charts/chart1.xml", encoder.encode('<a:latin typeface="Fraunces &amp; Co"/>')],
      ["docProps/app.xml", encoder.encode('<a:latin typeface="Ignored"/>')],
    ]);
    expect(deckTypefaces(parts)).toEqual(
      new Set(["poppins", "inter", "noto sans", "fraunces & co"]),
    );
  });

  it("names the fonts an edit sets, chart text included", () => {
    expect(
      operationTypefaces([
        { kind: "setTheme", headingFont: "Poppins", bodyFont: " Inter " },
        { kind: "addChart", style: { textFont: "Lato" } },
      ]),
    ).toEqual(new Set(["poppins", "inter", "lato"]));
  });

  it("hands a job only the faces its text can use, by either name", () => {
    const faces = [face("Poppins"), face("Montserrat SemiBold", "Montserrat"), face("Lato")];
    expect(facesFor(faces, new Set(["poppins", "montserrat"])).map((f) => f.family)).toEqual([
      "Poppins",
      "Montserrat SemiBold",
    ]);
  });
});
