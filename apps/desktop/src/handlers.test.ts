import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { vi } from "vitest";

// Whether `rg` answers is decided per test, so both backends are proven
// against the same folder and the same expectations. The handlers ask this
// module which backend to use, so the switch is real; `calls` proves it.
const ripgrep = vi.hoisted(() => ({ present: true, calls: 0 }));
vi.mock("./ripgrep.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ripgrep.ts")>();
  const counted =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A) => {
      ripgrep.calls += 1;
      return fn(...args);
    };
  return {
    ...original,
    ripgrepAvailable: () => original.ripgrepAvailable().then((real) => real && ripgrep.present),
    findWithRipgrep: counted(original.findWithRipgrep),
    searchWithRipgrep: counted(original.searchWithRipgrep),
  };
});
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DesktopError,
  LIMITS,
  WORKSPACE_FOLDER_NAME,
  makeDesktopResponder,
  type DesktopHandlers,
} from "@chat/desktop-rpc";
import { makeExecutions } from "./executions.ts";
import { GrantStore } from "./grants.ts";
import { WorkspaceRegistry } from "./workspaces.ts";
import { makeHandlers, type Shell } from "./handlers.ts";
import * as diff from "./diff.ts";
import type { EgressGrant } from "./egress-grants.ts";
import type { AnswerKey, ChatKey, GrantTarget } from "./scoped-grants.ts";
import { Sandbox } from "./sandbox.ts";

/**
 * The handlers are the layer a compromised or confused caller actually reaches,
 * so containment is asserted here too and not only against `resolveInFolder`.
 * A handler that forgot to resolve would pass those unit tests and fail these.
 *
 * The model's address for a file is its real absolute path; receipts name the
 * file back as `rootName/relative`, so `root` and `workspaceDir` below are the
 * two addresses every call is built from.
 */
let root: string;
let outsideDir: string;
let workspaceRoot: string;
let handlers: DesktopHandlers;
let picked: string | null;
let ran: { command: string; cwd: string; allowWrite: string[] }[];
let revealed: { absolute: string; mode: string }[];
/** What the operating system complained about, when the test wants it to. */
let revealComplaint: string | null;
/** When set, a command signals it started and then runs until released. */
let heldCommand: { started: () => void; release: Promise<void> } | null = null;
const ORIGIN = "https://chat.test";
let approvedNetwork: Array<{ target: GrantTarget; grant: EgressGrant }> = [];
let keptAnswers: Array<{ origin: string; live: AnswerKey[] }> = [];
let forgotten: ChatKey[] = [];
const forgottenSites: string[] = [];
const revokedPaths: Array<{ target: GrantTarget; path: string }> = [];

const CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const FRESH_CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c8";
const RELOCATED_CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c9";
const SOURCE_CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4ca";
const BRANCH_CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4cb";
const SUBMISSION = "550e8400-e29b-41d4-a716-446655440000";
const RESERVATION = "550e8400-e29b-41d4-a716-446655440001";

/** Never runs anything: these tests are about the path boundary, not the sandbox. */
const stubSandbox = Layer.succeed(
  Sandbox,
  Sandbox.of({
    availability: () => Effect.succeed({ kind: "ready" as const }),
    setUp: () => Effect.succeed({ kind: "ready" as const }),
    permissions: (target) =>
      Effect.succeed(
        target.scope === "always"
          ? {
              network: [{ host: "github.com", port: 22, privateNetwork: false }],
              paths: [],
              capabilities: [],
            }
          : { network: [], paths: ["/opt/specs"], capabilities: ["local-services", "ssh-agent"] },
      ),
    forgetChat: (chat) =>
      Effect.sync(() => {
        forgotten.push(chat);
      }),
    approveNetwork: (target, grant) =>
      Effect.sync(() => {
        approvedNetwork.push({ target, grant });
      }),
    revokeNetwork: () => Effect.void,
    keepAnswers: (origin, live) =>
      Effect.sync(() => {
        keptAnswers.push({ origin, live: [...live] });
      }),
    checkFolder: (path) =>
      path.endsWith("app-data")
        ? Effect.fail(new DesktopError({ reason: "failed", message: "Never shared." }))
        : Effect.void,
    approvePath: (_target, path) => Effect.succeed(path),
    approveCapability: () => Effect.void,
    revokeCapability: () => Effect.void,
    agentSetting: () => Effect.succeed({ current: null, found: [], choosable: true, added: [] }),
    forgetKeys: () => Effect.void,
    chooseAgent: () => Effect.succeed(false),
    revokePath: (target, path) =>
      Effect.sync(() => {
        revokedPaths.push({ target, path });
      }),
    run: ({ command, cwd, allowWrite }) =>
      Effect.promise(async () => {
        ran.push({ command, cwd, allowWrite: [...allowWrite] });
        if (heldCommand) {
          heldCommand.started();
          await heldCommand.release;
        }
        return { exitCode: 0, output: "", truncated: false, violations: [] };
      }),
  }),
);

/** The workspace's on-disk address for a conversation. */
const workspaceDir = (conversationId: string) => join(workspaceRoot, conversationId);

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "chat-handlers-")));
  root = join(base, "site");
  outsideDir = join(base, "elsewhere");
  workspaceRoot = join(base, "workspaces");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export {}\n");
  await writeFile(join(outsideDir, "secrets.txt"), "token\n");
  await symlink(outsideDir, join(root, "escape"));

  const shell: Shell = {
    pickDirectory: async () => picked,
    revealPath: async (absolute, mode) => {
      revealed.push({ absolute, mode });
      return revealComplaint;
    },
    serverOrigin: () => ORIGIN,
    executionSession: () => ({
      id: "test-session",
      machineId: "machine-1",
      machineName: "Test Mac",
    }),
    cancelCall: () => false,
    setWorkState: () => {},
    forgetChatSites: async (conversationId) => {
      forgottenSites.push(conversationId);
    },
    networkGrantsDirectory: join(root, "network-grants"),
  };

  handlers = await Effect.runPromise(
    makeHandlers(shell).pipe(
      Effect.provide(
        Layer.mergeAll(
          GrantStore.layerEphemeral,
          WorkspaceRegistry.layerEphemeral(workspaceRoot),
          stubSandbox,
        ),
      ),
    ),
  );
});

afterAll(async () => {
  await rm(resolve(root, ".."), { recursive: true, force: true });
});

const attach = async () => {
  picked = root;
  await Effect.runPromise(handlers.chooseFolder({ conversationId: CONVERSATION }));
};

const failureOf = async <A>(effect: Effect.Effect<A, { reason: string }>) => {
  const outcome = await Effect.runPromise(Effect.result(effect));
  return outcome._tag === "Failure" ? outcome.failure.reason : `unexpected success`;
};

beforeAll(() => {
  ran = [];
  revealed = [];
  revealComplaint = null;
});

describe("before a folder is attached", () => {
  it("still answers through the workspace, which is always there", async () => {
    const fresh = FRESH_CONVERSATION;
    const ws = workspaceDir(fresh);
    // A work chat without a user folder still has its own workspace, listed
    // by its real path so the model can address it.
    const top = await Effect.runPromise(
      handlers.listDirectory({ conversationId: fresh, callId: "t", path: "." }),
    );
    expect(top.entries).toEqual([{ name: ws, kind: "directory" }]);
    expect(
      await failureOf(
        handlers.readFile({ callId: "t", conversationId: fresh, path: join(root, "src/index.ts") }),
      ),
    ).toBe("outside-folder");
    await Effect.runPromise(
      handlers.writeFile({
        conversationId: fresh,
        callId: "t",
        path: join(ws, "note.txt"),
        text: "hi",
      }),
    );
    expect(await readFile(join(workspaceRoot, fresh, "note.txt"), "utf8")).toBe("hi");

    // A server file lands beside it; a second copy takes a new name rather
    // than replacing the first.
    const pdf = Buffer.from("%PDF-1.4 minimal");
    const first = await Effect.runPromise(
      handlers.saveToWorkspace({
        conversationId: fresh,
        callId: "s1",
        fileName: "q3.pdf",
        base64: pdf.toString("base64"),
      }),
    );
    expect(first).toEqual({ path: join(ws, "q3.pdf"), created: true, bytes: pdf.length });
    const second = await Effect.runPromise(
      handlers.saveToWorkspace({
        conversationId: fresh,
        callId: "s2",
        fileName: "q3.pdf",
        base64: pdf.toString("base64"),
      }),
    );
    expect(second.path).toBe(join(ws, "q3-1.pdf"));
    expect(await readFile(first.path)).toEqual(pdf);
    // Path components in the name are not honoured: the file stays in the root.
    const escaped = await Effect.runPromise(
      handlers.saveToWorkspace({
        conversationId: fresh,
        callId: "s3",
        fileName: "../escape.txt",
        base64: Buffer.from("x").toString("base64"),
      }),
    );
    expect(escaped.path).toBe(join(ws, "escape.txt"));
    // A chosen path, approved by the person, is written exactly there,
    // replacing what was; outside the chat's roots it is refused.
    const placed = await Effect.runPromise(
      handlers.saveToWorkspace({
        conversationId: fresh,
        callId: "s4",
        fileName: "q3.pdf",
        base64: pdf.toString("base64"),
        path: join(ws, "reports", "final.pdf"),
      }),
    );
    expect(placed).toEqual({
      path: join(ws, "reports", "final.pdf"),
      created: true,
      bytes: pdf.length,
    });
    expect(await readFile(join(ws, "reports", "final.pdf"))).toEqual(pdf);
    expect(
      await failureOf(
        handlers.saveToWorkspace({
          conversationId: fresh,
          callId: "s5",
          fileName: "q3.pdf",
          base64: pdf.toString("base64"),
          path: join(root, "..", "outside.pdf"),
        }),
      ),
    ).toBe("outside-folder");

    ran = [];
    await Effect.runPromise(
      handlers.runCommand({
        conversationId: fresh,
        callId: "c",
        generationId: "generation-1",
        command: "echo hi",
        timeoutMs: 1000,
      }),
    );
    expect(ran).toHaveLength(1);
    // The command starts in the workspace and may write there.
    expect(ran[0]?.cwd).toBe(ws);
    expect(ran[0]?.allowWrite).toEqual([ws]);
  });

  it("reports no user folder and the workspace path without scanning it", async () => {
    const state = await Effect.runPromise(
      handlers.folderStatus({ conversationId: FRESH_CONVERSATION }),
    );
    expect(state.folders).toEqual([]);
    expect(state.workspace.path).toBe(workspaceDir(FRESH_CONVERSATION));
  });
});

describe("once a folder is attached", () => {
  beforeAll(attach);

  it("reports the folder with its path, which is the model's address for it", async () => {
    const state = await Effect.runPromise(handlers.folderStatus({ conversationId: CONVERSATION }));

    expect(state.folders).toEqual([{ name: "site", path: root, alive: true }]);
  });

  it("reads and writes inside it by absolute path", async () => {
    const contents = await Effect.runPromise(
      handlers.readFile({
        callId: "t",
        conversationId: CONVERSATION,
        path: join(root, "src", "index.ts"),
      }),
    );
    expect(contents.text).toBe("export {}\n");
    // Receipts keep the short name form for the transcript.
    expect(contents.path).toBe("site/src/index.ts");

    const huge = join(root, "src", "huge.log");
    await writeFile(huge, "a".repeat(LIMITS.readBytes + 1_000));
    const truncated = await Effect.runPromise(
      handlers.readFile({
        callId: "t",
        conversationId: CONVERSATION,
        path: huge,
      }),
    );
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toHaveLength(LIMITS.readChars);
    await writeFile(join(root, "src", "too-big.txt"), "b".repeat(LIMITS.writeBytes + 1));
    expect(
      await failureOf(
        handlers.editFile({
          conversationId: CONVERSATION,
          callId: "t",
          path: join(root, "src", "too-big.txt"),
          old: "b",
          new: "c",
          all: false,
        }),
      ),
    ).toBe("too-large");

    const receipt = await Effect.runPromise(
      handlers.writeFile({
        conversationId: CONVERSATION,
        callId: "t",
        path: join(root, "src", "new", "note.md"),
        text: "hello",
      }),
    );
    expect(receipt.created).toBe(true);
    expect(receipt.path).toBe("site/src/new/note.md");
    expect(await readFile(join(root, "src", "new", "note.md"), "utf8")).toBe("hello");
  });

  it("holds a write until a running command has finished", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    heldCommand = { started: started.resolve, release: release.promise };
    const command = Effect.runPromise(
      handlers.runCommand({
        conversationId: CONVERSATION,
        callId: "slow",
        generationId: "generation-1",
        command: "ln -sfn ~/Library/LaunchAgents out",
        timeoutMs: 1000,
      }),
    );
    await started.promise;
    heldCommand = null;
    const target = join(root, "src", "after-command.md");
    const write = Effect.runPromise(
      handlers.writeFile({ conversationId: CONVERSATION, callId: "w", path: target, text: "hi" }),
    );
    // Proves absence, so it can only pass wrongly, never fail wrongly: an
    // unheld write of two bytes lands long before this.
    const early = await Promise.race([
      write.then(() => "written"),
      new Promise((done) => setTimeout(() => done("held"), 250)),
    ]);
    expect(early).toBe("held");
    release.resolve();
    await Promise.all([command, write]);
    expect(await readFile(target, "utf8")).toBe("hi");
  });

  it("reads a window of lines and says where more follows", async () => {
    const path = join(root, "src", "lines.txt");
    const numbered = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`);
    await writeFile(path, numbered.join(""));
    const read = (window: { offset?: number; limit?: number }) =>
      Effect.runPromise(
        handlers.readFile({ conversationId: CONVERSATION, callId: "r", path, ...window }),
      );

    expect(await read({ offset: 3, limit: 2 })).toMatchObject({
      text: "line 3\nline 4\n",
      truncated: true,
      startLine: 3,
      nextLine: 5,
    });
    // To the end: the file exactly, final newline included, and its length known.
    expect(await read({ offset: 9 })).toMatchObject({
      text: "line 9\nline 10\n",
      truncated: false,
      lineCount: 10,
    });
    expect(await read({ offset: 40 })).toMatchObject({ text: "", lineCount: 10 });
  });

  it("pages a file longer than one read, and a line with no end", async () => {
    const path = join(root, "src", "long.txt");
    const content = `${"x".repeat(999)}\n`.repeat(200) + "tail";
    await writeFile(path, content);
    let paged = "";
    let reads = 0;
    let offset: number | undefined;
    for (;;) {
      const page = await Effect.runPromise(
        handlers.readFile({
          conversationId: CONVERSATION,
          callId: "r",
          path,
          ...(offset ? { offset } : {}),
        }),
      );
      expect(page.text.length).toBeLessThanOrEqual(LIMITS.readChars);
      paged += page.text;
      reads += 1;
      if (!page.truncated) {
        expect(page.lineCount).toBe(201);
        break;
      }
      offset = page.nextLine;
    }
    expect(reads).toBeGreaterThan(1);
    expect(paged).toBe(content);

    // Minified: one line far longer than a read is cut, and the line after it can be reached.
    const minified = join(root, "src", "min.js");
    await writeFile(minified, `${"y".repeat(LIMITS.readChars * 3)}\nafter\n`);
    expect(
      await Effect.runPromise(
        handlers.readFile({ conversationId: CONVERSATION, callId: "r", path: minified }),
      ),
    ).toMatchObject({ truncated: true, nextLine: 2 });
    expect(
      await Effect.runPromise(
        handlers.readFile({ conversationId: CONVERSATION, callId: "r", path: minified, offset: 2 }),
      ),
    ).toMatchObject({ text: "after\n", lineCount: 2 });
  });

  it("refuses to read a binary file as text", async () => {
    await writeFile(
      join(root, "src", "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]),
    );
    expect(
      await failureOf(
        handlers.readFile({
          callId: "t",
          conversationId: CONVERSATION,
          path: join(root, "src", "logo.png"),
        }),
      ),
    ).toBe("not-text");
  });

  it("reads an image as bytes and refuses anything else", async () => {
    const image = await Effect.runPromise(
      handlers.readBinary({
        callId: "t",
        conversationId: CONVERSATION,
        path: join(root, "src", "logo.png"),
        purpose: "view",
      }),
    );
    expect(image.mediaType).toBe("image/png");
    expect(image.path).toBe("site/src/logo.png");
    expect(Buffer.from(image.base64, "base64")[0]).toBe(0x89);
    expect(
      await failureOf(
        handlers.readBinary({
          callId: "t",
          conversationId: CONVERSATION,
          path: join(root, "src", "index.ts"),
          purpose: "view",
        }),
      ),
    ).toBe("not-binary");
  });

  it("imports a picture or PowerPoint for server tools, and a plain read still refuses a deck", async () => {
    const deck = join(root, "src", "deck.pptx");
    await writeFile(deck, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    const imported = await Effect.runPromise(
      handlers.readBinary({
        callId: "t",
        conversationId: CONVERSATION,
        path: deck,
        purpose: "import",
      }),
    );
    expect(imported).toMatchObject({
      path: "site/src/deck.pptx",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes: 7,
    });
    expect(
      await failureOf(
        handlers.readBinary({
          callId: "t",
          conversationId: CONVERSATION,
          path: deck,
          purpose: "view",
        }),
      ),
    ).toBe("not-binary");
    expect(
      await failureOf(
        handlers.readBinary({
          callId: "t",
          conversationId: CONVERSATION,
          path: join(root, "src", "index.ts"),
          purpose: "import",
        }),
      ),
    ).toBe("not-binary");
  });

  it("edits by exact unique match and returns the diff", async () => {
    await writeFile(join(root, "src", "edit.ts"), "const a = 1;\nconst b = 1;\nconst c = 2;\n");
    expect(
      await failureOf(
        handlers.editFile({
          conversationId: CONVERSATION,
          callId: "t",
          path: join(root, "src", "edit.ts"),
          old: "= 1;",
          new: "= 9;",
          all: false,
        }),
      ),
    ).toBe("ambiguous-match");
    expect(
      await failureOf(
        handlers.editFile({
          conversationId: CONVERSATION,
          callId: "t",
          path: join(root, "src", "edit.ts"),
          old: "const z",
          new: "x",
          all: false,
        }),
      ),
    ).toBe("no-match");

    const receipt = await Effect.runPromise(
      handlers.editFile({
        conversationId: CONVERSATION,
        callId: "t",
        path: join(root, "src", "edit.ts"),
        old: "const c = 2;",
        new: "const c = 3;",
        all: false,
      }),
    );
    expect(receipt.replacements).toBe(1);
    expect(receipt.diff).toContain("-const c = 2;\n+const c = 3;");
    expect(await readFile(join(root, "src", "edit.ts"), "utf8")).toBe(
      "const a = 1;\nconst b = 1;\nconst c = 3;\n",
    );

    const every = await Effect.runPromise(
      handlers.editFile({
        conversationId: CONVERSATION,
        callId: "t",
        path: join(root, "src", "edit.ts"),
        old: "= 1;",
        new: "= 0;",
        all: true,
      }),
    );
    expect(every.replacements).toBe(2);
  });

  it("refuses to edit a file that is not UTF-8 rather than damage it", async () => {
    const path = join(root, "src", "latin1.txt");
    // "café = 1" in Latin-1, whose é is not UTF-8.
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x3d, 0x20, 0x31, 0x0a]);
    await writeFile(path, latin1);
    expect(
      await failureOf(
        handlers.editFile({
          conversationId: CONVERSATION,
          callId: "e",
          path,
          old: "= 1",
          new: "= 2",
          all: false,
        }),
      ),
    ).toBe("not-text");
    expect(await readFile(path)).toEqual(latin1);

    // A byte order mark survives an edit.
    const bom = join(root, "src", "bom.txt");
    await writeFile(bom, "\uFEFFvalue = 1\n");
    await Effect.runPromise(
      handlers.editFile({
        conversationId: CONVERSATION,
        callId: "e",
        path: bom,
        old: "= 1",
        new: "= 2",
        all: false,
      }),
    );
    expect(await readFile(bom, "utf8")).toBe("\uFEFFvalue = 2\n");
  });

  it("matches lines written with \\n in a file with Windows line endings, and keeps them", async () => {
    const path = join(root, "src", "windows.txt");
    await writeFile(path, "first\r\nsecond\r\nthird\r\n");
    await Effect.runPromise(
      handlers.editFile({
        conversationId: CONVERSATION,
        callId: "e",
        path,
        old: "first\nsecond",
        new: "first\nnew\nsecond",
        all: false,
      }),
    );
    expect(await readFile(path, "utf8")).toBe("first\r\nnew\r\nsecond\r\nthird\r\n");
  });

  it("still matches \\n lines exactly in a file with a stray Windows line ending", async () => {
    const path = join(root, "src", "mixed.txt");
    await writeFile(path, "pasted\r\nfirst\nsecond\n");
    await Effect.runPromise(
      handlers.editFile({
        conversationId: CONVERSATION,
        callId: "e",
        path,
        old: "first\nsecond",
        new: "first\nnew\nsecond",
        all: false,
      }),
    );
    expect(await readFile(path, "utf8")).toBe("pasted\r\nfirst\nnew\nsecond\n");
  });

  it("keeps both of two edits to one file made at once", async () => {
    const path = join(root, "src", "both.ts");
    await writeFile(path, "const a = 1;\nconst b = 2;\n");
    const edit = (old: string, replacement: string) =>
      Effect.runPromise(
        handlers.editFile({
          conversationId: CONVERSATION,
          callId: "e",
          path,
          old,
          new: replacement,
          all: false,
        }),
      );
    await Promise.all([edit("a = 1", "a = 10"), edit("b = 2", "b = 20")]);
    expect(await readFile(path, "utf8")).toBe("const a = 10;\nconst b = 20;\n");
  });

  it("moves without overwriting and deletes, but never a root itself", async () => {
    await writeFile(join(root, "src", "old.txt"), "x");
    await writeFile(join(root, "src", "taken.txt"), "y");
    expect(
      await failureOf(
        handlers.movePath({
          conversationId: CONVERSATION,
          callId: "t",
          from: join(root, "src", "old.txt"),
          to: join(root, "src", "taken.txt"),
        }),
      ),
    ).toBe("already-exists");
    expect(
      await failureOf(
        handlers.movePath({
          conversationId: CONVERSATION,
          callId: "t",
          from: join(root, "src", "old.txt"),
          to: join(root, "..", "away.txt"),
        }),
      ),
    ).toBe("outside-folder");
    const moved = await Effect.runPromise(
      handlers.movePath({
        conversationId: CONVERSATION,
        callId: "t",
        from: join(root, "src", "old.txt"),
        to: join(root, "src", "sub", "new.txt"),
      }),
    );
    expect(moved).toEqual({ from: "site/src/old.txt", to: "site/src/sub/new.txt" });
    expect(await readFile(join(root, "src", "sub", "new.txt"), "utf8")).toBe("x");

    const gone = await Effect.runPromise(
      handlers.deletePath({
        callId: "t",
        conversationId: CONVERSATION,
        paths: [join(root, "src", "sub")],
      }),
    );
    expect(gone).toEqual({
      deleted: [{ path: "site/src/sub", kind: "directory" }],
      failed: [],
    });
    expect(
      await failureOf(
        handlers.readFile({
          callId: "t",
          conversationId: CONVERSATION,
          path: join(root, "src", "sub", "new.txt"),
        }),
      ),
    ).toBe("not-found");
    expect(
      await Effect.runPromise(
        handlers.deletePath({ callId: "t", conversationId: CONVERSATION, paths: [root] }),
      ),
    ).toEqual({
      deleted: [],
      failed: [
        {
          path: root,
          reason: "outside-folder",
          message: "The folder itself cannot be deleted.",
        },
      ],
    });
  });

  it("deletes several paths in one call and keeps going after a miss", async () => {
    await writeFile(join(root, "src", "a.txt"), "a");
    await writeFile(join(root, "src", "b.txt"), "b");
    const receipt = await Effect.runPromise(
      handlers.deletePath({
        callId: "t",
        conversationId: CONVERSATION,
        paths: [
          join(root, "src", "a.txt"),
          join(root, "src", "missing.txt"),
          join(root, "src", "a.txt"),
          join(root, "src", "b.txt"),
          root,
        ],
      }),
    );
    expect(receipt.deleted).toEqual([
      { path: "site/src/a.txt", kind: "file" },
      { path: "site/src/b.txt", kind: "file" },
    ]);
    expect(receipt.failed).toEqual([
      {
        path: join(root, "src", "missing.txt"),
        reason: "not-found",
        message: "site/src/missing.txt does not exist.",
      },
      {
        path: root,
        reason: "outside-folder",
        message: "The folder itself cannot be deleted.",
      },
    ]);
    // The workspace itself is protected by the same rule, and survives.
    const ws = workspaceDir(CONVERSATION);
    expect(
      await Effect.runPromise(
        handlers.deletePath({ callId: "t", conversationId: CONVERSATION, paths: [ws] }),
      ),
    ).toEqual({
      deleted: [],
      failed: [
        {
          path: ws,
          reason: "outside-folder",
          message: "The folder itself cannot be deleted.",
        },
      ],
    });
    // And the contents rule is real, not just the root rule.
    await Effect.runPromise(
      handlers.writeFile({
        conversationId: CONVERSATION,
        callId: "t",
        path: join(ws, "scratch.txt"),
        text: "scratch",
      }),
    );
    const wsGone = await Effect.runPromise(
      handlers.deletePath({
        callId: "t",
        conversationId: CONVERSATION,
        paths: [join(ws, "scratch.txt")],
      }),
    );
    expect(wsGone.deleted).toEqual([
      { path: `${WORKSPACE_FOLDER_NAME}/scratch.txt`, kind: "file" },
    ]);
    expect(
      await failureOf(
        handlers.readFile({
          callId: "t",
          conversationId: CONVERSATION,
          path: join(root, "src", "a.txt"),
        }),
      ),
    ).toBe("not-found");
  });

  it.each([true, false])(
    "finds by glob and searches by regex, ignoring what git ignores (ripgrep: %s)",
    async (withRipgrep) => {
      ripgrep.present = withRipgrep;
      ripgrep.calls = 0;
      const rgInstalled = await (await import("./ripgrep.ts")).ripgrepAvailable();
      await writeFile(join(root, ".gitignore"), "ignored/\n");
      await mkdir(join(root, "ignored"), { recursive: true });
      await writeFile(join(root, "ignored", "noise.ts"), "needle");
      await writeFile(join(root, "src", "hay.ts"), "no\nneedle here\nno");

      const found = await Effect.runPromise(
        handlers.findFiles({ callId: "t", conversationId: CONVERSATION, pattern: "*.ts" }),
      );
      // Results are the model's addresses: real absolute paths.
      expect(found.paths).toContain(join(root, "src", "hay.ts"));
      expect(found.paths).not.toContain(join(root, "ignored", "noise.ts"));
      const scoped = await Effect.runPromise(
        handlers.findFiles({
          callId: "t",
          conversationId: CONVERSATION,
          pattern: "src/**/*.ts",
        }),
      );
      expect(scoped.paths).toContain(join(root, "src", "hay.ts"));
      await writeFile(join(root, ".env"), "SECRET=1\n");
      const hidden = await Effect.runPromise(
        handlers.findFiles({ callId: "t", conversationId: CONVERSATION, pattern: ".env" }),
      );
      expect(hidden.paths).toContain(join(root, ".env"));

      const hits = await Effect.runPromise(
        handlers.searchFiles({
          conversationId: CONVERSATION,
          callId: "t",
          pattern: "needle",
          glob: "src/**",
        }),
      );
      expect(hits.matches).toEqual([
        { path: join(root, "src", "hay.ts"), line: 2, text: "needle here" },
      ]);
      expect(hits.filesSearched).toBeGreaterThan(0);
      expect(
        await failureOf(
          handlers.searchFiles({ callId: "t", conversationId: CONVERSATION, pattern: "(" }),
        ),
      ).toBe("bad-pattern");
      // The glob dialects differ, so each backend has its own unreadable glob;
      // what they share is that it is a refusal, not a defect.
      const badGlob = withRipgrep && rgInstalled ? "[" : "{?}";
      expect(
        await failureOf(
          handlers.searchFiles({
            callId: "t",
            conversationId: CONVERSATION,
            pattern: "x",
            glob: badGlob,
          }),
        ),
      ).toBe("bad-pattern");
      // The mocked switch reached the handlers: rg ran only when it was allowed to.
      if (rgInstalled) expect(ripgrep.calls > 0).toBe(withRipgrep);
      else expect(ripgrep.calls).toBe(0);
    },
  );

  it("finds a matching folder and the files inside it", async () => {
    await mkdir(join(root, "DVR", "extracted_images"), { recursive: true });
    await writeFile(join(root, "DVR", "extracted_images", "frame.png"), "png");
    await writeFile(join(root, "DVR", "readme.txt"), "no");
    const found = await Effect.runPromise(
      handlers.findFiles({ callId: "t", conversationId: CONVERSATION, pattern: "**/*extracted*" }),
    );
    expect(found.paths).toContain(join(root, "DVR", "extracted_images") + "/");
    expect(found.paths).toContain(join(root, "DVR", "extracted_images", "frame.png"));
    expect(found.paths).not.toContain(join(root, "DVR", "readme.txt"));
  });

  it("refuses to read or write through a symlink that leaves it", async () => {
    expect(
      await failureOf(
        handlers.readFile({
          callId: "t",
          conversationId: CONVERSATION,
          path: join(root, "escape", "secrets.txt"),
        }),
      ),
    ).toBe("outside-folder");
    expect(
      await failureOf(
        handlers.writeFile({
          conversationId: CONVERSATION,
          callId: "t",
          path: join(root, "escape", "planted.txt"),
          text: "x",
        }),
      ),
    ).toBe("outside-folder");
  });

  it("never writes an outside target through a dangling symlink", async () => {
    const target = join(outsideDir, "not-created.txt");
    await symlink(target, join(root, "dangling"));
    const outcome = await Effect.runPromise(
      Effect.result(
        handlers.writeFile({
          conversationId: CONVERSATION,
          callId: "t",
          path: join(root, "dangling"),
          text: "escaped",
        }),
      ),
    );
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.failure.reason).toBe("not-found");
      expect(outcome.failure.message).not.toContain(outsideDir);
    }
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });

    await symlink(join(outsideDir, "missing-directory"), join(root, "dangling-dir"));
    expect(
      await failureOf(
        handlers.writeFile({
          conversationId: CONVERSATION,
          callId: "t",
          path: join(root, "dangling-dir", "nested.txt"),
          text: "escaped",
        }),
      ),
    ).toBe("not-found");
    await expect(
      readFile(join(outsideDir, "missing-directory", "nested.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("inserts replacement metacharacters literally (all: %s)", async (all) => {
    const text = all ? "left TARGET middle TARGET right" : "left TARGET right";
    const replacement = "$& $$ $` $' $1";
    await writeFile(join(root, "literal.txt"), text);
    await Effect.runPromise(
      handlers.editFile({
        conversationId: CONVERSATION,
        callId: "t",
        path: join(root, "literal.txt"),
        old: "TARGET",
        new: replacement,
        all,
      }),
    );
    expect(await readFile(join(root, "literal.txt"), "utf8")).toBe(
      text.split("TARGET").join(replacement),
    );
  });

  it.each([false, true])(
    "refuses projected output over the byte limit before replacement or diff (all: %s)",
    async (all) => {
      const path = join(root, "expansion.txt");
      const original = all ? "aa" : "a";
      await writeFile(path, original);
      const after = "é".repeat(all ? 500_001 : 1_000_001);
      const construct = vi.spyOn(String.prototype, all ? "replaceAll" : "replace");
      const preview = vi.spyOn(diff, "unifiedDiff");
      try {
        expect(
          await failureOf(
            handlers.editFile({
              conversationId: CONVERSATION,
              callId: "size",
              path,
              old: "a",
              new: after,
              all,
            }),
          ),
        ).toBe("too-large");
        expect(construct.mock.calls.some(([old]) => old === "a")).toBe(false);
        expect(preview).not.toHaveBeenCalled();
        expect(await readFile(path, "utf8")).toBe(original);
      } finally {
        construct.mockRestore();
        preview.mockRestore();
        await rm(path);
      }
    },
  );

  it.each([false, true])(
    "accepts the exact decimal byte boundary including multibyte text (all: %s)",
    async (all) => {
      expect(LIMITS.writeBytes).toBe(2_000_000);
      const path = join(root, "exact-edit.txt");
      await writeFile(path, all ? "aa" : "a");
      const after = "é".repeat(all ? 500_000 : 1_000_000);
      try {
        const receipt = await Effect.runPromise(
          handlers.editFile({
            conversationId: CONVERSATION,
            callId: "exact",
            path,
            old: "a",
            new: after,
            all,
          }),
        );
        expect(receipt.replacements).toBe(all ? 2 : 1);
        expect((await readFile(path)).byteLength).toBe(LIMITS.writeBytes);
      } finally {
        await rm(path);
      }
    },
  );

  it("refuses an edit exactly one UTF-8 byte over the limit", async () => {
    const path = join(root, "one-byte-over.txt");
    await writeFile(path, "za");
    try {
      expect(
        await failureOf(
          handlers.editFile({
            conversationId: CONVERSATION,
            callId: "one-byte-over",
            path,
            old: "a",
            new: "é".repeat(1_000_000),
            all: false,
          }),
        ),
      ).toBe("too-large");
      expect(await readFile(path, "utf8")).toBe("za");
    } finally {
      await rm(path);
    }
  });

  it("counts nonoverlapping matches and leaves malformed source untouched", async () => {
    const path = join(root, "malformed-edit.txt");
    const source = Buffer.concat([Buffer.from("TARGET"), Buffer.alloc(666_665, 0xff)]);
    await writeFile(path, source);
    try {
      expect(
        await failureOf(
          handlers.editFile({
            conversationId: CONVERSATION,
            callId: "malformed",
            path,
            old: "TARGET",
            new: "long replacement",
            all: false,
          }),
        ),
      ).toBe("not-text");
      expect(await readFile(path)).toEqual(source);
      await writeFile(path, "aaaaa");
      const receipt = await Effect.runPromise(
        handlers.editFile({
          conversationId: CONVERSATION,
          callId: "nonoverlap",
          path,
          old: "aa",
          new: "é",
          all: true,
        }),
      );
      expect(receipt.replacements).toBe(2);
      expect(await readFile(path, "utf8")).toBe("ééa");
    } finally {
      await rm(path);
    }
  });

  it("replays a real edit after renderer replacement without editing the file again", async () => {
    await writeFile(join(root, "replay.txt"), "original");
    const respond = makeDesktopResponder(handlers);
    const executions = makeExecutions((tag, payload, signal) =>
      Effect.runPromise(respond(tag, payload), { signal }),
    );
    const payload = {
      callId: "replay-edit",
      conversationId: CONVERSATION,
      path: join(root, "replay.txt"),
      old: "original",
      new: "changed",
      all: false,
    };
    const first = await executions.request("editFile", payload);
    expect(first).toMatchObject({ ok: true, value: { replacements: 1 } });
    expect(await executions.request("editFile", payload)).toEqual(first);
    expect(await readFile(join(root, "replay.txt"), "utf8")).toBe("changed");
    await executions.dispose();
  });

  it("hands the file manager a real path, and never one the site only named", async () => {
    revealed = [];
    await Effect.runPromise(
      handlers.revealPath({
        conversationId: CONVERSATION,
        path: join(root, "src", "index.ts"),
        mode: "reveal",
      }),
    );
    expect(revealed).toEqual([{ absolute: join(root, "src", "index.ts"), mode: "reveal" }]);

    // Same containment as every other file procedure, because the click comes
    // from the same remote page the model's calls come from.
    for (const path of [join(root, "escape", "secrets.txt"), join(outsideDir, "secrets.txt")]) {
      expect(
        await failureOf(handlers.revealPath({ conversationId: CONVERSATION, path, mode: "open" })),
      ).toBe("outside-folder");
    }
    expect(
      await failureOf(
        handlers.revealPath({
          conversationId: CONVERSATION,
          path: join(root, "src", "nothing-here.txt"),
          mode: "reveal",
        }),
      ),
    ).toBe("not-found");
    // A dangling symlink resolves to nothing, so it can never be handed over.
    expect(
      await failureOf(
        handlers.revealPath({
          conversationId: CONVERSATION,
          path: join(root, "dangling"),
          mode: "open",
        }),
      ),
    ).toBe("not-found");
    expect(revealed).toHaveLength(1);
  });

  it("opens only a kind of file its default application displays", async () => {
    revealed = [];
    await writeFile(join(root, "install.command"), "rm -rf /\n");
    await writeFile(join(root, "drawing.svg"), '<svg onload="alert(1)"></svg>');
    await writeFile(join(root, "runme"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    // Terminal runs a .terminal's command; a .webloc opens whatever it points at.
    await writeFile(join(root, "summary.terminal"), "<plist/>");
    await writeFile(join(root, "report.webloc"), "<plist/>");
    await writeFile(join(root, "install.pkg"), "payload");
    // A listed kind a command marked executable is still refused.
    await writeFile(join(root, "notes.txt"), "#!/bin/sh\n", { mode: 0o755 });
    const refused = [
      join(root, "install.command"),
      join(root, "drawing.svg"),
      join(root, "runme"),
      join(root, "summary.terminal"),
      join(root, "report.webloc"),
      join(root, "install.pkg"),
      join(root, "notes.txt"),
    ];
    for (const path of refused) {
      expect(
        await failureOf(handlers.revealPath({ conversationId: CONVERSATION, path, mode: "open" })),
      ).toBe("not-openable");
      // Showing it in the folder is the answer offered instead, so it must work.
      await Effect.runPromise(
        handlers.revealPath({ conversationId: CONVERSATION, path, mode: "reveal" }),
      );
    }
    expect(revealed.map((call) => call.mode)).toEqual(refused.map(() => "reveal"));

    // The extension is compared without case, as the system resolves it.
    await writeFile(join(root, "photo.PNG"), "png");
    await Effect.runPromise(
      handlers.revealPath({
        conversationId: CONVERSATION,
        path: join(root, "photo.PNG"),
        mode: "open",
      }),
    );
    expect(revealed.at(-1)?.mode).toBe("open");

    // Two causes, two sentences, both naming the file the short way.
    const refusalFor = async (path: string) => {
      const outcome = await Effect.runPromise(
        Effect.result(handlers.revealPath({ conversationId: CONVERSATION, path, mode: "open" })),
      );
      return outcome._tag === "Failure" ? outcome.failure.message : "unexpected success";
    };
    expect(await refusalFor(join(root, "runme"))).toBe(
      "site/runme is marked executable, so opening it could run it. Show it in the folder instead.",
    );
    expect(await refusalFor(join(root, "drawing.svg"))).toBe(
      "site/drawing.svg is not a kind of file the app opens directly. Show it in the folder instead.",
    );
  });

  it("reports the operating system's refusal instead of claiming it opened", async () => {
    await writeFile(join(root, "notes.md"), "# Notes\n");
    revealComplaint = "no application knows this file";
    expect(
      await failureOf(
        handlers.revealPath({
          conversationId: CONVERSATION,
          path: join(root, "notes.md"),
          mode: "open",
        }),
      ),
    ).toBe("failed");
    revealComplaint = null;
  });

  it("carries reveal across the bridge and refuses an unknown mode there", async () => {
    revealed = [];
    const respond = makeDesktopResponder(handlers);
    const ask = (payload: unknown) => Effect.runPromise(respond("revealPath", payload));
    expect(
      await ask({
        conversationId: CONVERSATION,
        path: join(root, "src", "index.ts"),
        mode: "reveal",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(revealed).toHaveLength(1);

    expect(
      await ask({
        conversationId: CONVERSATION,
        path: join(root, "src", "index.ts"),
        mode: "launch",
      }),
    ).toMatchObject({ ok: false, error: { reason: "failed" } });
    expect(
      await ask({
        conversationId: CONVERSATION,
        path: join(root, "escape", "secrets.txt"),
        mode: "open",
      }),
    ).toMatchObject({ ok: false, error: { reason: "outside-folder" } });
    expect(revealed).toHaveLength(1);
  });

  it("refuses a traversal and a path under no root", async () => {
    expect(
      await failureOf(
        handlers.readFile({
          conversationId: CONVERSATION,
          callId: "t",
          path: join(root, "..", "elsewhere", "secrets.txt"),
        }),
      ),
    ).toBe("outside-folder");
    expect(
      await failureOf(
        handlers.readFile({
          conversationId: CONVERSATION,
          callId: "t",
          path: join(outsideDir, "secrets.txt"),
        }),
      ),
    ).toBe("outside-folder");
  });

  it("runs a command in the workspace, with every attached folder writable", async () => {
    ran = [];
    await Effect.runPromise(
      handlers.runCommand({
        conversationId: CONVERSATION,
        callId: "call-1",
        generationId: "generation-1",
        command: "echo hi",
        timeoutMs: 1000,
      }),
    );

    const ws = workspaceDir(CONVERSATION);
    expect(ran).toHaveLength(1);
    // Always the workspace, so a command that creates files lands there.
    expect(ran[0]?.cwd).toBe(ws);
    // cp between roots works: workspace plus the attached folder.
    expect(ran[0]?.allowWrite).toEqual([ws, root]);
  });

  it("attaches a second folder, addresses both by path, and refuses a name clash", async () => {
    picked = outsideDir;
    const two = await Effect.runPromise(handlers.chooseFolder({ conversationId: CONVERSATION }));
    expect(two.folders.map((folder) => folder.name)).toEqual(["site", "elsewhere"]);

    // The root of the model's world is the list of roots, by real path.
    const ws = workspaceDir(CONVERSATION);
    const top = await Effect.runPromise(
      handlers.listDirectory({ callId: "t", conversationId: CONVERSATION, path: "." }),
    );
    expect(top.entries.map((entry) => entry.name)).toEqual([ws, root, outsideDir]);
    // A plain file carries its size, so an empty extensionless file is not
    // mistaken for a folder.
    const inside = await Effect.runPromise(
      handlers.listDirectory({ callId: "t", conversationId: CONVERSATION, path: outsideDir }),
    );
    expect(inside.entries).toContainEqual({ name: "secrets.txt", kind: "file", size: 6 });

    const secret = await Effect.runPromise(
      handlers.readFile({
        callId: "t",
        conversationId: CONVERSATION,
        path: join(outsideDir, "secrets.txt"),
      }),
    );
    expect(secret.text).toBe("token\n");
    expect(secret.path).toBe("elsewhere/secrets.txt");

    // A command may write to every root, which is what makes a cp between
    // the attached folder and the workspace work.
    ran = [];
    await Effect.runPromise(
      handlers.runCommand({
        conversationId: CONVERSATION,
        callId: "call-3",
        generationId: "generation-1",
        command: "echo hi",
        timeoutMs: 1000,
      }),
    );
    expect(ran[0]?.cwd).toBe(ws);
    expect(ran[0]?.allowWrite).toEqual([ws, root, outsideDir]);

    // A different folder with the same name would be unaddressable in the UI.
    const clashDir = join(root, "..", "clash", "elsewhere");
    await mkdir(clashDir, { recursive: true });
    picked = clashDir;
    expect(await failureOf(handlers.chooseFolder({ conversationId: CONVERSATION }))).toBe(
      "already-exists",
    );

    await Effect.runPromise(
      handlers.detachFolder({ conversationId: CONVERSATION, name: "elsewhere" }),
    );
    picked = root;
  });

  it("never moves a root itself, which could leave it in the workspace", async () => {
    const movable = join(root, "..", "movable");
    await mkdir(movable, { recursive: true });
    await writeFile(join(movable, "keep.txt"), "kept\n");
    picked = movable;
    await Effect.runPromise(handlers.chooseFolder({ conversationId: CONVERSATION }));
    expect(
      await failureOf(
        handlers.movePath({
          conversationId: CONVERSATION,
          callId: "t",
          from: movable,
          to: join(workspaceDir(CONVERSATION), "movable"),
        }),
      ),
    ).toBe("outside-folder");
    expect(await readFile(join(movable, "keep.txt"), "utf8")).toBe("kept\n");
    await Effect.runPromise(
      handlers.detachFolder({ conversationId: CONVERSATION, name: "movable" }),
    );
  });

  it("forgets the folder on request", async () => {
    await Effect.runPromise(
      handlers.detachFolder({ conversationId: CONVERSATION, name: "elsewhere" }),
    );
    await Effect.runPromise(handlers.detachFolder({ conversationId: CONVERSATION, name: "site" }));

    const state = await Effect.runPromise(handlers.folderStatus({ conversationId: CONVERSATION }));
    expect(state.folders).toEqual([]);
    await attach();
  });

  it("replaces a lost folder when choosing it again", async () => {
    const id = RELOCATED_CONVERSATION;
    const original = join(root, "..", "relocate-a", "site");
    const moved = join(root, "..", "relocate-b", "site");
    await mkdir(original, { recursive: true });
    await mkdir(moved, { recursive: true });
    picked = original;
    await Effect.runPromise(handlers.chooseFolder({ conversationId: id }));
    await rm(original, { recursive: true, force: true });
    const lost = await Effect.runPromise(handlers.folderStatus({ conversationId: id }));
    expect(lost.folders).toEqual([{ name: "site", path: original, alive: false }]);
    picked = moved;
    const again = await Effect.runPromise(
      handlers.chooseFolder({ conversationId: id, replace: "site" }),
    );
    expect(again.folders).toEqual([{ name: "site", path: moved, alive: true }]);
    picked = root;
  });

  it("refuses a folder the sandbox will not open to commands", async () => {
    const refused = join(root, "..", "app-data");
    await mkdir(refused, { recursive: true });
    picked = refused;
    expect(await failureOf(handlers.chooseFolder({ conversationId: CONVERSATION }))).toBe("failed");
    const state = await Effect.runPromise(handlers.folderStatus({ conversationId: CONVERSATION }));
    expect(state.folders.map((folder) => folder.path)).not.toContain(refused);
    picked = root;
  });

  it("stops using an attached folder once a link replaces it", async () => {
    const id = SOURCE_CONVERSATION;
    const project = join(root, "..", "swapped", "project");
    const elsewhere = join(root, "..", "swapped", "elsewhere");
    await mkdir(project, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    picked = project;
    await Effect.runPromise(handlers.chooseFolder({ conversationId: id }));
    // A command in another chat that can write the parent swaps the folder for a link.
    await rm(project, { recursive: true });
    await symlink(elsewhere, project);
    ran = [];
    await Effect.runPromise(
      handlers.runCommand({
        conversationId: id,
        callId: "swap",
        generationId: "generation-1",
        command: "echo hi",
        timeoutMs: 1000,
      }),
    );
    expect(ran[0]?.allowWrite).not.toContain(await realpath(elsewhere));
    const state = await Effect.runPromise(handlers.folderStatus({ conversationId: id }));
    expect(state.folders.find((folder) => folder.name === "project")?.alive).toBe(false);
    await Effect.runPromise(handlers.detachFolder({ conversationId: id, name: "project" }));
    picked = root;
  });

  it("keeps the workspace name for the workspace alone", async () => {
    const named = join(root, "..", "named-workspace", WORKSPACE_FOLDER_NAME);
    await mkdir(named, { recursive: true });
    picked = named;
    expect(await failureOf(handlers.chooseFolder({ conversationId: CONVERSATION }))).toBe(
      "already-exists",
    );
    expect(
      await failureOf(
        handlers.detachFolder({ conversationId: CONVERSATION, name: WORKSPACE_FOLDER_NAME }),
      ),
    ).toBe("already-exists");
    picked = root;
  });

  it("stages files outside the workspace and promotes the complete batch", async () => {
    const first = await Effect.runPromise(
      handlers.stageFile({
        conversationId: CONVERSATION,
        submissionId: SUBMISSION,
        fileName: "../Report.PDF",
        base64: Buffer.from("pdf-bytes").toString("base64"),
      }),
    );
    const second = await Effect.runPromise(
      handlers.stageFile({
        conversationId: CONVERSATION,
        submissionId: SUBMISSION,
        fileName: "Report.PDF",
        base64: Buffer.from("other").toString("base64"),
      }),
    );
    expect(first.name).toBe("Report.PDF");
    expect(second.name).toBe("Report-1.PDF");
    expect(
      await failureOf(
        handlers.readFile({
          callId: "t",
          conversationId: CONVERSATION,
          path: join(workspaceDir(CONVERSATION), "Report.PDF"),
        }),
      ),
    ).toBe("not-found");

    const promoted = await Effect.runPromise(
      handlers.promoteSubmission({
        conversationId: CONVERSATION,
        submissionId: SUBMISSION,
        reservationId: RESERVATION,
      }),
    );
    expect(promoted.files.map((file) => file.finalName)).toEqual(["Report-1.PDF", "Report.PDF"]);
    expect(await Effect.runPromise(handlers.listPendingPromotions(undefined))).toEqual([
      { conversationId: CONVERSATION, submissionId: SUBMISSION, reservationId: RESERVATION },
    ]);
    await Effect.runPromise(
      handlers.commitPromotion({ conversationId: CONVERSATION, reservationId: RESERVATION }),
    );

    const contents = await Effect.runPromise(
      handlers.readFile({
        callId: "t",
        conversationId: CONVERSATION,
        path: join(workspaceDir(CONVERSATION), "Report.PDF"),
      }),
    );
    expect(contents.text).toBe("pdf-bytes");
    expect(contents.path).toBe(`${WORKSPACE_FOLDER_NAME}/Report.PDF`);
  });

  it("discards staged files without exposing them to the workspace", async () => {
    const submissionId = "550e8400-e29b-41d4-a716-446655440002";
    await Effect.runPromise(
      handlers.stageFile({
        conversationId: CONVERSATION,
        submissionId,
        fileName: "discard.txt",
        base64: Buffer.from("discard").toString("base64"),
      }),
    );
    await Effect.runPromise(
      handlers.discardStagedFile({
        conversationId: CONVERSATION,
        submissionId,
        name: "discard.txt",
      }),
    );
    await Effect.runPromise(
      handlers.discardSubmission({ conversationId: CONVERSATION, submissionId }),
    );
    expect(
      await failureOf(
        handlers.readFile({
          callId: "t",
          conversationId: CONVERSATION,
          path: join(workspaceDir(CONVERSATION), "discard.txt"),
        }),
      ),
    ).toBe("not-found");
  });

  it("copies a branch's workspace and grants without touching the source", async () => {
    const branch = BRANCH_CONVERSATION;
    // Isolated source conversation: the suite's shared one picks up and drops
    // folders as earlier tests run.
    picked = root;
    await Effect.runPromise(handlers.chooseFolder({ conversationId: SOURCE_CONVERSATION }));
    const sourceId = SOURCE_CONVERSATION;
    const submissionId = "550e8400-e29b-41d4-a716-446655440003";
    const reservationId = "550e8400-e29b-41d4-a716-446655440004";
    await Effect.runPromise(
      handlers.stageFile({
        conversationId: sourceId,
        submissionId,
        fileName: "keep.txt",
        base64: Buffer.from("keep").toString("base64"),
      }),
    );
    await Effect.runPromise(
      handlers.promoteSubmission({ conversationId: sourceId, submissionId, reservationId }),
    );
    await Effect.runPromise(handlers.commitPromotion({ conversationId: sourceId, reservationId }));
    await Effect.runPromise(
      handlers.copyFolderGrants({ fromConversationId: sourceId, toConversationId: branch }),
    );
    await Effect.runPromise(
      handlers.cloneWorkspace({ fromConversationId: sourceId, toConversationId: branch }),
    );
    const state = await Effect.runPromise(handlers.folderStatus({ conversationId: branch }));
    expect(state.folders.map((folder) => folder.name)).toEqual(["site"]);
    const contents = await Effect.runPromise(
      handlers.readFile({
        callId: "t",
        conversationId: branch,
        path: join(workspaceDir(branch), "keep.txt"),
      }),
    );
    expect(contents.text).toBe("keep");
    // Copy, not move: the source still answers.
    const source = await Effect.runPromise(handlers.folderStatus({ conversationId: sourceId }));
    expect(source.folders.map((folder) => folder.name)).toEqual(["site"]);

    // A second clone refuses to merge into what the branch already has.
    expect(
      await failureOf(
        handlers.cloneWorkspace({ fromConversationId: sourceId, toConversationId: branch }),
      ),
    ).toBe("already-exists");
    picked = root;
  });

  it("discards a conversation's workspace, and the folders and sites it was granted", async () => {
    const attached = await Effect.runPromise(
      handlers.folderStatus({ conversationId: BRANCH_CONVERSATION }),
    );
    expect(attached.folders.length).toBeGreaterThan(0);
    await Effect.runPromise(handlers.discardWorkspace({ conversationId: BRANCH_CONVERSATION }));
    const after = await Effect.runPromise(
      handlers.folderStatus({ conversationId: BRANCH_CONVERSATION }),
    );
    expect(after.folders).toEqual([]);
    expect(forgottenSites).toContain(BRANCH_CONVERSATION);
    expect(
      await failureOf(
        handlers.readFile({
          callId: "t",
          conversationId: BRANCH_CONVERSATION,
          path: join(workspaceDir(BRANCH_CONVERSATION), "keep.txt"),
        }),
      ),
    ).toBe("not-found");
  });
});

describe("network permission boundary", () => {
  const ask = (overrides: Partial<Parameters<typeof handlers.requestNetworkAccess>[0]> = {}) => ({
    conversationId: CONVERSATION,
    callId: "network-ask",
    generationId: "generation-1",
    host: "EXAMPLE.ORG",
    port: 443,
    privateNetwork: false,
    scope: "answer" as const,
    ...overrides,
  });

  it("grants an exact destination without requiring a failed command first", async () => {
    const commandsBefore = ran.length;
    const grantsBefore = approvedNetwork.length;
    expect(await Effect.runPromise(handlers.requestNetworkAccess(ask()))).toEqual({
      host: "example.org",
      port: 443,
      privateNetwork: false,
      scope: "answer",
    });
    expect(approvedNetwork.slice(grantsBefore)).toEqual([
      {
        target: {
          scope: "answer",
          answer: { origin: ORIGIN, conversationId: CONVERSATION, attempt: "generation-1" },
        },
        grant: { host: "example.org", port: 443, privateNetwork: false },
      },
    ]);
    expect(ran).toHaveLength(commandsBefore);
  });

  it("scopes a grant to the chat or to every chat as asked", async () => {
    const before = approvedNetwork.length;
    await Effect.runPromise(handlers.requestNetworkAccess(ask({ scope: "chat", port: 22 })));
    await Effect.runPromise(handlers.requestNetworkAccess(ask({ scope: "always" })));
    expect(approvedNetwork.slice(before).map(({ target }) => target)).toEqual([
      { scope: "chat", chat: { origin: ORIGIN, conversationId: CONVERSATION } },
      { scope: "always" },
    ]);
  });

  it("needs a private network request for a private address, and says so", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(handlers.requestNetworkAccess(ask({ host: "10.0.0.5" }))),
    );
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: {
        reason: "failed",
        message: "10.0.0.5 is on a private network. Request it with privateNetwork true.",
      },
    });
    expect(
      await Effect.runPromise(
        handlers.requestNetworkAccess(ask({ host: "10.0.0.5", privateNetwork: true })),
      ),
    ).toMatchObject({ host: "10.0.0.5", privateNetwork: true });
  });

  it("grants a public address like a name", async () => {
    expect(
      await Effect.runPromise(
        handlers.requestNetworkAccess(ask({ host: "91.99.224.73", port: 22, scope: "chat" })),
      ),
    ).toMatchObject({ host: "91.99.224.73", port: 22, privateNetwork: false });
  });

  it("lists a chat's own grants apart from those every chat has", async () => {
    expect(
      await Effect.runPromise(handlers.chatPermissions({ conversationId: CONVERSATION })),
    ).toEqual({
      chat: [{ kind: "path", path: "/opt/specs" }, { kind: "local" }, { kind: "ssh-agent" }],
      always: [{ kind: "network", host: "github.com", port: 22, privateNetwork: false }],
    });
  });

  it("removes only from the chat's own grants", async () => {
    await Effect.runPromise(
      handlers.revokeChatPermission({
        conversationId: CONVERSATION,
        permission: { kind: "path", path: "/opt/specs" },
      }),
    );
    expect(revokedPaths.at(-1)).toEqual({
      target: { scope: "chat", chat: { origin: ORIGIN, conversationId: CONVERSATION } },
      path: "/opt/specs",
    });
    expect(
      await failureOf(
        handlers.revokeChatPermission({
          conversationId: CONVERSATION,
          permission: { kind: "network", host: "Not Canonical", port: 443, privateNetwork: false },
        }),
      ),
    ).toBe("failed");
  });

  it("forgets a chat's grants when its workspace is discarded for good", async () => {
    const before = forgotten.length;
    await Effect.runPromise(handlers.discardWorkspace({ conversationId: CONVERSATION }));
    expect(forgotten.slice(before)).toEqual([{ origin: ORIGIN, conversationId: CONVERSATION }]);
  });

  it("ends the answers the page no longer lists as running", async () => {
    const before = keptAnswers.length;
    await Effect.runPromise(
      handlers.setWorkState({
        active: 1,
        needsApproval: 0,
        attempts: [{ conversationId: CONVERSATION, generationId: "generation-2" }],
      }),
    );
    expect(keptAnswers.slice(before)).toEqual([
      {
        origin: ORIGIN,
        live: [{ origin: ORIGIN, conversationId: CONVERSATION, attempt: "generation-2" }],
      },
    ]);
  });

  it("refuses invalid destinations without granting access", async () => {
    const before = approvedNetwork.length;
    for (const host of ["*.example.org", "https://example.org", "127.0.0.1"]) {
      expect(
        await failureOf(handlers.requestNetworkAccess(ask({ callId: "invalid-network", host }))),
      ).toBe("failed");
    }
    expect(approvedNetwork).toHaveLength(before);
  });

  it("refuses direct file-tool writes and moves of the permission directory", async () => {
    await attach();
    const protectedFile = join(root, "network-grants", "approved.json");
    expect(
      await failureOf(
        handlers.writeFile({
          conversationId: CONVERSATION,
          callId: "f",
          path: protectedFile,
          text: "[]",
        }),
      ),
    ).toBe("outside-folder");
    expect(
      await failureOf(
        handlers.movePath({
          conversationId: CONVERSATION,
          callId: "m",
          from: join(root, "src"),
          to: join(root, "network-grants"),
        }),
      ),
    ).toBe("outside-folder");
    const deletion = await Effect.runPromise(
      handlers.deletePath({
        conversationId: CONVERSATION,
        callId: "d",
        paths: [join(root, "network-grants")],
      }),
    );
    expect(deletion.failed[0]?.reason).toBe("outside-folder");
  });
});
