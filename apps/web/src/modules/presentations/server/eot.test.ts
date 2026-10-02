import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fontFacts, toEot } from "./eot.ts";

const abril = new Uint8Array(
  readFileSync(
    join(import.meta.dirname, "../../../../tests/fixtures/fonts/AbrilFatface-Regular.ttf"),
  ),
);

describe("an embedded OpenType wrapper", () => {
  it("states its sizes, version and names, then carries the font byte for byte", () => {
    const eot = toEot(abril);
    const view = new DataView(eot.buffer, eot.byteOffset, eot.byteLength);
    expect(view.getUint32(0, true)).toBe(eot.length);
    expect(view.getUint32(4, true)).toBe(abril.length);
    expect(view.getUint32(8, true)).toBe(0x00020002);
    // No subsetting, compression or obfuscation: the font stays editable.
    expect(view.getUint32(12, true)).toBe(0);
    expect(view.getUint16(34, true)).toBe(0x504c);
    // The first name after the fixed header is the family, UTF-16LE.
    const size = view.getUint16(82, true);
    expect(new TextDecoder("utf-16le").decode(eot.subarray(84, 84 + size))).toBe("Abril Fatface");
    expect(Buffer.from(eot.subarray(eot.length - abril.length)).equals(Buffer.from(abril))).toBe(
      true,
    );
  });

  it("reads the PANOSE a deck's font list records", () => {
    expect(fontFacts(abril).panose).toMatch(/^[0-9A-F]{20}$/);
  });
});
