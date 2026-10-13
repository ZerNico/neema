import { describe, expect, it } from "vitest";
import {
  approvalKind,
  deletePathsOf,
  desktopToolsSystemHint,
  forTranscript,
} from "./tool-schema.ts";

describe("desktop tools system hint", () => {
  it("names the absolute path as the address space", () => {
    const hint = desktopToolsSystemHint([{ name: "DVR", path: "/home/user/DVR" }], true);
    expect(hint).toContain('attached a folder on their computer at "/home/user/DVR" ("DVR")');
    expect(hint).toContain('Paths are absolute, like "/home/user/DVR/README.md"');
    expect(hint).toContain("anything outside the attached folders is refused");
    expect(hint).toContain("Put every path you mean to delete in one delete_local_file call");
  });

  it("names every attached folder with its path", () => {
    const hint = desktopToolsSystemHint(
      [
        { name: "site", path: "/home/user/site" },
        { name: "notes", path: "/home/user/notes" },
      ],
      true,
    );
    expect(hint).toContain('"/home/user/site" ("site"), "/home/user/notes" ("notes")');
    expect(hint).toContain('Paths are absolute, like "/home/user/site/README.md"');
    expect(hint).toContain('list_folder with "." lists them');
    expect(hint).not.toContain("DVR");
  });

  it("says nothing about commands where they are unavailable", () => {
    const hint = desktopToolsSystemHint([{ name: "DVR", path: "/home/user/DVR" }], false);
    expect(hint).toContain("Running commands is unavailable on this computer");
    expect(hint).not.toContain("sandboxed");
    expect(hint).not.toContain("request_network_access");
    expect(hint).not.toContain("Python");
    expect(hint).not.toContain("Node");
    expect(hint).not.toContain("authenticated proxies");
  });

  it("credits the workspace to the chat, never to the user", () => {
    const hint = desktopToolsSystemHint(
      [{ name: "workspace", path: "/data/workspaces/abc" }],
      true,
    );
    // The user never picked it; "has attached" must not credit them with it.
    expect(hint).not.toContain("has attached");
    expect(hint).toContain(
      "this chat's own workspace on the user's computer at \"/data/workspaces/abc\"",
    );
    expect(hint).toContain("Files the user drops into the chat land in the workspace");
    expect(hint).toContain('Paths are absolute, like "/data/workspaces/abc/README.md"');
    expect(hint).toContain("save_to_workspace copies it into the workspace by its attachment id");
  });

  it("names the workspace first and the attached folders after it", () => {
    const hint = desktopToolsSystemHint(
      [
        { name: "workspace", path: "/data/workspaces/abc" },
        { name: "site", path: "/home/user/site" },
      ],
      true,
    );
    expect(hint).toContain(
      'workspace at "/data/workspaces/abc" and inside a folder the user attached at "/home/user/site" ("site")',
    );
    expect(hint).toContain("Files the user drops into the chat land in the workspace");
    expect(hint).toContain("Commands run sandboxed and start in the workspace");
    expect(hint).toContain("`cd` and `cp` between them work");
    expect(hint).toContain("request_network_access with its exact host and port");
    expect(hint).toContain("Work permissions never grant network access");
  });

  it("explains portable runtime discovery and the sandbox environment upfront", () => {
    const hint = desktopToolsSystemHint([{ name: "workspace", path: "/work" }], true);
    expect(hint).toContain("local file tools act inside");
    expect(hint).toContain("read permitted toolchain locations and system libraries");
    expect(hint).not.toContain("reads and writes may land only inside");
    expect(hint).toContain("Python or Node through run_command");
    expect(hint).toContain("no dedicated language tool is needed");
    expect(hint).toContain("discover the executable and version");
    expect(hint).toContain("rather than assuming a command name, version or installed package");
    expect(hint).toContain("Install dependencies locally (a virtualenv, node_modules)");
    expect(hint).toContain("chosen Python interpreter’s `-m pip`");
    expect(hint).toContain("Each command is a fresh process");
    expect(hint).toContain(
      "activation, environment variables and directory changes do not persist",
    );
    expect(hint).toContain("Temporary files and Python caches default to the workspace");
    expect(hint).toContain("files instead of opening GUI windows");
    expect(hint).toContain("supplied authenticated proxy");
    expect(hint).toContain("explicit proxy support, including authentication");
    expect(hint).toContain("Do not bypass the proxy or sandbox restrictions");
    expect(hint).toContain("a failed command is not required");
    expect(hint).toContain("A refusal is an answer, not an error to work around");
  });

  it("leaves the workspace unmentioned when the shell predates it", () => {
    const hint = desktopToolsSystemHint([{ name: "DVR", path: "/home/user/DVR" }], true);
    expect(hint).not.toContain("drops into the chat");
  });
});

describe("approvalKind", () => {
  it("asks for nothing when a chat's own file is saved into the workspace", () => {
    // The workspace is app-owned and a drop lands there unasked; the copy
    // never overwrites, so there is nothing for a person to weigh.
    expect(approvalKind("save_to_workspace", {})).toBeNull();
    // Saving to a chosen place can replace a file, so it asks like a write.
    expect(approvalKind("save_to_workspace", { path: "/Users/a/out.pdf" })).toBe("edit");
    expect(approvalKind("write_local_file", {})).toBe("edit");
    expect(approvalKind("request_network_access", {})).toBe("network");
    // Only a navigation with an address is a new site; back and reload stay put.
    expect(approvalKind("browser_navigate", { url: "https://a.test" })).toBe("site");
    expect(approvalKind("browser_navigate", { action: "back" })).toBeNull();
    expect(approvalKind("browser_scroll", {})).toBeNull();
    expect(approvalKind("browser_click", {})).toBe("browser-action");
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
