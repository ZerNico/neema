import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.ts";

describe("unifiedDiff", () => {
  it("produces a real patch for a localized change in a large file", () => {
    const before = Array.from({ length: 30_000 }, (_, i) => `line ${i}\n`).join("");
    const after = before.replace("line 15000\n", "changed\n");
    const { diff: patch, truncated } = unifiedDiff("file.txt", before, after);
    expect(truncated).toBe(false);
    expect(patch).toContain("-line 15000\n+changed\n");
    expect(applyPatch(before, patch)).toBe(after);
    expect(patch.length).toBeLessThan(500);
  });

  it("bounds unrelated-line computation with an explicit content preview", () => {
    const before = Array.from({ length: 5_000 }, (_, i) => `before ${i}\n`).join("");
    const after = Array.from({ length: 5_000 }, (_, i) => `after ${i}\n`).join("");
    const { diff: preview, truncated } = unifiedDiff("file.txt", before, after);
    expect(truncated).toBe(true);
    expect(preview).toContain("Full diff omitted");
    expect(preview).toContain("-before 0");
    expect(preview).toContain("+after 0");
    expect(preview.length).toBeLessThan(5_000);
  });

  it("shows an edit past a huge common prefix without diffing the full input", () => {
    const prefix = "unchanged\n".repeat(250_000);
    const { diff: preview, truncated } = unifiedDiff("file.txt", `${prefix}old`, `${prefix}new`);
    expect(truncated).toBe(true);
    expect(preview).toContain("Full diff omitted");
    expect(preview).toContain("-old");
    expect(preview).toContain("+new");
    expect(preview.length).toBeLessThan(5_000);
  });
});
