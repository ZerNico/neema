import { describe, expect, it } from "vitest";
import { LIMITS } from "@chat/desktop-rpc";
import { acceptDesktopToolResult } from "./result.ts";
import type { DesktopToolResult } from "../tool-schema.ts";

const png = (size: number) => {
  const bytes = Buffer.alloc(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
};

const ok = (overrides: Partial<DesktopToolResult> = {}): DesktopToolResult => ({
  v: 1,
  ok: true,
  summary: "Read site/logo.png",
  detail: "image/png, 20 bytes",
  truncated: false,
  ...overrides,
});

describe("acceptDesktopToolResult", () => {
  it("keeps a sniffed PNG and caps prose", () => {
    const bytes = png(20);
    const accepted = acceptDesktopToolResult(
      ok({
        summary: `${"x".repeat(2_000)}\u0000`,
        detail: `${"y".repeat(LIMITS.readChars + 50)}\u0000`,
        violations: ["denied\u0000", ...Array.from({ length: 40 }, () => "x")],
        file: { mediaType: "image/png", base64: bytes.toString("base64"), name: "logo.png" },
      }),
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.summary).toHaveLength(1_024);
    expect(accepted.detail).toHaveLength(LIMITS.readChars);
    expect(accepted.truncated).toBe(true);
    expect(accepted.violations).toHaveLength(32);
    expect(accepted.violations?.some((item) => item.includes("\u0000"))).toBe(false);
    expect(accepted.file?.mediaType).toBe("image/png");
  });

  it("drops SVG, mismatched types, and oversized base64 without decoding them", () => {
    const pngBytes = png(20);
    expect(
      acceptDesktopToolResult(
        ok({
          file: {
            mediaType: "image/svg+xml",
            base64: Buffer.from("<svg></svg>").toString("base64"),
            name: "drawing.svg",
          },
        }),
      ),
    ).toMatchObject({ ok: false, summary: "That file could not be sent" });
    expect(
      acceptDesktopToolResult(
        ok({
          file: { mediaType: "image/jpeg", base64: pngBytes.toString("base64"), name: "x.jpg" },
        }),
      ).ok,
    ).toBe(false);
    const oversized = "A".repeat(Math.ceil((LIMITS.binaryBytes * 4) / 3) + 8);
    expect(
      acceptDesktopToolResult(ok({ file: { mediaType: "image/png", base64: oversized, name: "x" } }))
        .ok,
    ).toBe(false);
  });
});
