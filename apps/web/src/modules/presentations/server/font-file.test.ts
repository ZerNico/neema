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

/** The byte range of one glyph, found through the font's own tables. */
const glyphs = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, number>();
  for (let i = 0; i < view.getUint16(4); i++) {
    const at = 12 + i * 16;
    tables.set(String.fromCharCode(...bytes.subarray(at, at + 4)), view.getUint32(at + 8));
  }
  const count = view.getUint16(tables.get("maxp")! + 4);
  const long = view.getInt16(tables.get("head")! + 50) === 1;
  const loca = tables.get("loca")!;
  const at = (i: number) =>
    long ? view.getUint32(loca + i * 4) : view.getUint16(loca + i * 2) * 2;
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: tables.get("glyf")! + at(i),
    empty: at(i + 1) === at(i),
  })).filter((glyph) => !glyph.empty);
};

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
    expect(() => readFontFile(truncated)).toThrow("The font's tables run past its end.");
  });

  describe("outline complexity", () => {
    it("accepts CFF outlines whose charstrings are indexed per glyph", () => {
      const katex = dirname(createRequire(import.meta.url).resolve("katex/package.json"));
      const otf = new Uint8Array(readFileSync(join(katex, "src/fonts/lib/Extra.otf")));
      expect(readFontFile(otf)).toMatchObject({ format: "otf" });
      // The same face with its glyph count raised no longer matches its outlines.
      const view = new DataView(otf.buffer, otf.byteOffset, otf.byteLength);
      for (let i = 0; i < view.getUint16(4); i++) {
        const at = 12 + i * 16;
        if (String.fromCharCode(...otf.subarray(at, at + 4)) !== "maxp") continue;
        const maxp = view.getUint32(at + 8);
        view.setUint16(maxp + 4, view.getUint16(maxp + 4) + 1);
      }
      expect(() => readFontFile(otf)).toThrow(/match its glyph count/);
    });
    it("refuses a glyph whose outline has far more points than any text face", () => {
      const bytes = face("Carlito-Regular.ttf").slice();
      const view = new DataView(bytes.buffer);
      const simple = glyphs(bytes).find((glyph) => view.getInt16(glyph.start) === 1)!;
      view.setUint16(simple.start + 10, 20_000);
      expect(() => readFontFile(bytes)).toThrow(/too complex/);
    });

    it("refuses a composite glyph that places itself", () => {
      const bytes = face("Carlito-Regular.ttf").slice();
      const view = new DataView(bytes.buffer);
      const composite = glyphs(bytes).find((glyph) => view.getInt16(glyph.start) < 0)!;
      view.setUint16(composite.start + 12, composite.index);
      expect(() => readFontFile(bytes)).toThrow(/nests too deeply/);
    });
  });
});
