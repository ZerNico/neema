import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFontFile } from "./font-file.ts";

const bundled = join(
  dirname(createRequire(import.meta.url).resolve("@office-kit/pptx-preview/package.json")),
  "fonts",
);
const face = (name: string) => new Uint8Array(readFileSync(join(bundled, name)));

describe("readFontFile", () => {
  it("reads family, style and licence bits from a TrueType face", () => {
    expect(readFontFile(face("Carlito-Regular.ttf"))).toMatchObject({
      family: "Carlito",
      renderFamily: "Carlito",
      bold: false,
      italic: false,
      embeddable: true,
      format: "ttf",
    });
    expect(readFontFile(face("Caladea-BoldItalic.ttf"))).toMatchObject({
      family: "Caladea",
      bold: true,
      italic: true,
    });
  });

  it("refuses collections, web fonts and anything else with a reason", () => {
    const withSignature = (signature: string) => {
      const bytes = new Uint8Array(64);
      bytes.set(new TextEncoder().encode(signature));
      return bytes;
    };
    expect(() => readFontFile(withSignature("ttcf"))).toThrow(/collections/);
    expect(() => readFontFile(withSignature("wOF2"))).toThrow(/Web fonts/);
    expect(() => readFontFile(withSignature("%PDF"))).toThrow(/not a TrueType or OpenType/);
    const truncated = face("Carlito-Regular.ttf").slice(0, 400);
    expect(() => readFontFile(truncated)).toThrow();
  });
});
