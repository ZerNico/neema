import { describe, expect, it } from "vitest";
import { deletePathsOf, desktopToolsSystemHint, forTranscript } from "./tool-schema.ts";

describe("desktop tools system hint", () => {
  it("separates the file-tool address space from a command's working folder", () => {
    const hint = desktopToolsSystemHint(["DVR"], true);
    // The two rules are opposites, and a model told only the first one writes
    // `cd DVR && python DVR/main.py`, which fails twice over.
    expect(hint).toContain('Every path starts with that name, like "DVR/README.md"');
    expect(hint).toContain('a command in "DVR" takes "main.py"');
    expect(hint).toContain('"cd DVR" would fail');
    expect(hint).toContain("Put every path you mean to delete in one delete_local_file call");
  });

  it("names a folder the user actually attached in both examples", () => {
    const hint = desktopToolsSystemHint(["site", "notes"], true);
    expect(hint).toContain('"site/README.md"');
    expect(hint).toContain('"site/main.py"');
    expect(hint).not.toContain("DVR");
  });

  it("says nothing about command paths where commands are unavailable", () => {
    const hint = desktopToolsSystemHint(["DVR"], false);
    expect(hint).toContain("Running commands is unavailable on this computer");
    expect(hint).not.toContain("cd DVR");
    expect(hint).not.toContain("main.py");
  });
});

describe("deletePathsOf", () => {
  it("reads a list and still understands an older single path", () => {
    expect(deletePathsOf({ paths: ["a.txt", "b.txt", "a.txt", ""] })).toEqual(["a.txt", "b.txt"]);
    expect(deletePathsOf({ path: "old/" })).toEqual(["old/"]);
    expect(deletePathsOf({})).toEqual([]);
  });
});

describe("forTranscript", () => {
  it("strips NULs and caps every persisted field", () => {
    const stored = forTranscript({
      v: 1,
      ok: true,
      summary: `${"x".repeat(800)}\u0000`,
      detail: `${"y".repeat(3_000)}\u0000`,
      truncated: false,
      violations: ["denied\u0000", "ok", ...Array.from({ length: 30 }, () => "n")],
    });
    expect(stored.summary).toHaveLength(500);
    expect(stored.summary.includes("\u0000")).toBe(false);
    expect(stored.detail).toHaveLength(2_000);
    expect(stored.truncated).toBe(true);
    expect(stored.violations).toHaveLength(20);
    expect(stored.violations?.some((item) => item.includes("\u0000"))).toBe(false);
  });
});
