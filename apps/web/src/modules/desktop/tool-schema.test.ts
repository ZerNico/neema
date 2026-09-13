import { describe, expect, it } from "vitest";
import { desktopToolsSystemHint } from "./tool-schema.ts";

describe("desktop tools system hint", () => {
  it("separates the file-tool address space from a command's working folder", () => {
    const hint = desktopToolsSystemHint(["DVR"], true);
    // The two rules are opposites, and a model told only the first one writes
    // `cd DVR && python DVR/main.py`, which fails twice over.
    expect(hint).toContain('Every path starts with that name, like "DVR/README.md"');
    expect(hint).toContain('a command in "DVR" takes "main.py"');
    expect(hint).toContain('"cd DVR" would fail');
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
