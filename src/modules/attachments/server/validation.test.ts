import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { MAX_ATTACHMENT_BYTES } from "../constants.ts";
import {
  buildTextFence,
  sanitizeFileName,
  sniffBinaryMediaType,
  validateAttachment,
} from "./validation.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0);
const GIF = text("GIF89a....");
const WEBP = new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WEBPVP8 ")]);
const PDF = text("%PDF-1.7\n1 0 obj\n");

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
/** Expected-failure helper: swaps the channels so the error is the result. */
const runError = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("sniffBinaryMediaType", () => {
  it("recognizes every allowed binary type", () => {
    expect(sniffBinaryMediaType(PNG)).toBe("image/png");
    expect(sniffBinaryMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffBinaryMediaType(GIF)).toBe("image/gif");
    expect(sniffBinaryMediaType(WEBP)).toBe("image/webp");
    expect(sniffBinaryMediaType(PDF)).toBe("application/pdf");
  });

  it("tolerates junk before the PDF header but not past the scan window", () => {
    expect(sniffBinaryMediaType(new Uint8Array([...text("junk"), ...PDF]))).toBe("application/pdf");
    const far = new Uint8Array([...new Uint8Array(2000), ...PDF]);
    expect(sniffBinaryMediaType(far)).toBeNull();
  });

  it("does not mistake RIFF containers that are not WebP", () => {
    expect(
      sniffBinaryMediaType(new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WAVE")])),
    ).toBeNull();
  });
});

describe("sanitizeFileName", () => {
  it("strips directories and control characters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\temp\\notes.txt")).toBe("notes.txt");
    expect(sanitizeFileName("a\u0000b\u001fc.txt")).toBe("abc.txt");
  });

  it("falls back for names that sanitize away", () => {
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("..")).toBe("file");
    expect(sanitizeFileName("   ")).toBe("file");
  });

  it("caps the length while keeping the extension", () => {
    const long = `${"a".repeat(400)}.png`;
    const result = sanitizeFileName(long);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith(".png")).toBe(true);
  });
});

describe("validateAttachment", () => {
  it("trusts the bytes over the declared type", async () => {
    // Sniffing fails, the extension is not textual → rejected as a type error.
    const error = await runError(
      validateAttachment({
        fileName: "totally-an-image.png",
        declaredMediaType: "image/png",
        bytes: text("<html>not an image</html>"),
      }),
    );
    expect(error.cause).toBe("type");
  });

  it("normalizes text files to text/plain", async () => {
    const result = await run(
      validateAttachment({
        fileName: "src/main.ts",
        declaredMediaType: "video/mp4",
        bytes: text("export const x = 1\n"),
      }),
    );
    expect(result).toEqual({ fileName: "main.ts", mediaType: "text/plain", kind: "text" });
  });

  it("rejects binary garbage claiming to be text", async () => {
    const error = await runError(
      validateAttachment({
        fileName: "notes.txt",
        declaredMediaType: "text/plain",
        bytes: bytes(0xff, 0xfe, 0x00, 0x80, 0x81),
      }),
    );
    expect(error.cause).toBe("type");
  });

  it("rejects empty files and anything over the size cap", async () => {
    const empty = await runError(
      validateAttachment({ fileName: "a.txt", declaredMediaType: "text/plain", bytes: bytes() }),
    );
    expect(empty.cause).toBe("content");

    const oversized = await runError(
      validateAttachment({
        fileName: "big.txt",
        declaredMediaType: "text/plain",
        bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      }),
    );
    expect(oversized.cause).toBe("size");
  });

  it("accepts a file exactly at the cap", async () => {
    const atCap = new Uint8Array(MAX_ATTACHMENT_BYTES).fill(0x61);
    const result = await run(
      validateAttachment({ fileName: "big.txt", declaredMediaType: "text/plain", bytes: atCap }),
    );
    expect(result.kind).toBe("text");
  });
});

describe("buildTextFence", () => {
  it("labels the file and picks a language hint", () => {
    expect(buildTextFence({ fileName: "main.ts", text: "const x = 1" })).toBe(
      "Attached file: main.ts\n```typescript\nconst x = 1\n```",
    );
  });

  it("outgrows the longest backtick run in the content", () => {
    const fenced = buildTextFence({ fileName: "readme.md", text: "````\nnested\n````" });
    expect(fenced).toContain("`````markdown");
    expect(fenced.endsWith("\n`````")).toBe(true);
  });

  it("uses the caller's label for extracted documents", () => {
    expect(buildTextFence({ fileName: "paper.pdf", text: "body", label: "Extracted" })).toContain(
      "Extracted: paper.pdf",
    );
  });
});
