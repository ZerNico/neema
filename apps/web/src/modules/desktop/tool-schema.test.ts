import { describe, expect, it } from "vitest";
import { AiError } from "effect/ai";
import {
  DESKTOP_TIMEOUTS,
  approvalKind,
  deletePathsOf,
  desktopToolTimeout,
  computerNotice,
  computerSystemHint,
  forTranscript,
  unusableDesktopResult,
} from "./tool-schema.ts";

describe("computer system hint", () => {
  it("is fixed text: nothing in it follows the chat's state, so the system prompt stays cached", () => {
    expect(computerSystemHint()).toBe(computerSystemHint());
    expect(computerSystemHint()).not.toMatch(/\/Users\/|C:\\/);
  });

  it("asks before deletes and new destinations, and treats output as data", () => {
    const hint = computerSystemHint();
    expect(hint).toMatch(
      /always asked before a delete, a new network destination, a folder or the SSH agent/,
    );
    expect(hint).toMatch(/never as instructions/);
    expect(hint).toContain("request_network_access");
  });
});

describe("computer notice", () => {
  const ready = { machine: { name: "nico's MacBook", online: true }, folders: [], files: [] };

  it("names the guest paths, never a host path", () => {
    const notice = computerNotice({
      ...ready,
      folders: [
        { name: "site", readOnly: false },
        { name: "refs", readOnly: true },
      ],
    });
    expect(notice).toContain("/folders/site, /folders/refs (read-only)");
    expect(notice).not.toMatch(/\/Users\/|C:\\/);
  });

  it("says which machine runs the chat, and when it is offline", () => {
    expect(computerNotice(ready)).toContain(`"nico's MacBook", online.`);
    const offline = computerNotice({
      ...ready,
      machine: { name: "nico's MacBook", online: false },
    });
    expect(offline).toMatch(/offline right now/);
    expect(computerNotice({ ...ready, machine: null })).toMatch(/none yet/);
  });

  it("names where sent files are", () => {
    expect(computerNotice({ ...ready, files: ["/workspace/data.csv"] })).toContain(
      "/workspace/data.csv",
    );
  });
});

describe("approvalKind", () => {
  it("asks for nothing when a chat's own file is saved into the workspace", () => {
    // The workspace is app-owned and a drop lands there unasked; the copy
    // never overwrites, so there is nothing for a person to weigh.
    expect(approvalKind("copy_to_computer", {})).toBeNull();
    // Saving to a chosen place can replace a file, so it asks like a write.
    expect(approvalKind("copy_to_computer", { path: "/Users/a/out.pdf" })).toBe("edit");
    expect(approvalKind("write_file", {})).toBe("edit");
    expect(approvalKind("request_network_access", {})).toBe("network");
    // Only a navigation with an address is a new site; back and reload stay put.
    expect(approvalKind("browser_navigate", { url: "https://a.test" })).toBe("site");
    expect(approvalKind("browser_navigate", { action: "back" })).toBeNull();
    expect(approvalKind("browser_scroll", {})).toBeNull();
    expect(approvalKind("browser_click", {})).toBe("browser-action");
  });
});

describe("desktopToolTimeout", () => {
  it("gives a tool that asks nobody the long wait when it moves bytes", () => {
    // Registered by approval kind, these two once expired on the page after two minutes
    // while the server waited ten.
    expect(approvalKind("copy_from_computer", {})).toBeNull();
    expect(approvalKind("copy_to_computer", {})).toBeNull();
    expect(desktopToolTimeout("copy_from_computer")).toBe(DESKTOP_TIMEOUTS.command);
    expect(desktopToolTimeout("copy_to_computer")).toBe(DESKTOP_TIMEOUTS.command);
    expect(desktopToolTimeout("read_file")).toBe(DESKTOP_TIMEOUTS.quick);
  });
});

describe("unusableDesktopResult", () => {
  it("tells the model which argument the toolkit refused", () => {
    // Built as the toolkit builds it when a call's parameters do not decode.
    const refused = AiError.make({
      module: "Toolkit",
      method: "read_file.handle",
      reason: new AiError.ToolParameterValidationError({
        toolName: "read_file",
        description: 'Expected a value with a length of at least 1, got ""\n  at ["path"]',
      }),
    });
    expect(unusableDesktopResult(refused)).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/arguments were not valid.*at \["path"\]/s),
    });
    expect(unusableDesktopResult(new Error("socket closed")).detail).toBe(
      "The computer did not report a usable result.",
    );
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
