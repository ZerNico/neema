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
  LIMITS,
  WORKSPACE_FOLDER_NAME,
  makeDesktopResponder,
  type DesktopHandlers,
} from "@chat/desktop-rpc";
import { makeExecutions } from "./executions.ts";
import { GrantStore } from "./grants.ts";
import { WorkspaceRegistry } from "./workspaces.ts";
import { makeHandlers, type Shell } from "./handlers.ts";
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
    run: ({ command, cwd, allowWrite }) =>
      Effect.sync(() => {
        ran.push({ command, cwd, allowWrite: [...allowWrite] });
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
    serverOrigin: () => "https://chat.test",
    executionSession: () => ({
      id: "test-session",
      machineId: "machine-1",
      machineName: "Test Mac",
    }),
    cancelCall: () => false,
    setWorkState: () => {},
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

    ran = [];
    await Effect.runPromise(
      handlers.runCommand({
        conversationId: fresh,
        callId: "c",
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

  it("will not hand a file this computer would run to its default application", async () => {
    revealed = [];
    await writeFile(join(root, "install.command"), "rm -rf /\n");
    await writeFile(join(root, "drawing.svg"), '<svg onload="alert(1)"></svg>');
    await writeFile(join(root, "runme"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    for (const path of [
      join(root, "install.command"),
      join(root, "drawing.svg"),
      join(root, "runme"),
    ]) {
      expect(
        await failureOf(handlers.revealPath({ conversationId: CONVERSATION, path, mode: "open" })),
      ).toBe("not-openable");
      // Showing it in the folder is the answer offered instead, so it must work.
      await Effect.runPromise(
        handlers.revealPath({ conversationId: CONVERSATION, path, mode: "reveal" }),
      );
    }
    expect(revealed.map((call) => call.mode)).toEqual(["reveal", "reveal", "reveal"]);

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
      "site/drawing.svg is a kind of file that can run when it is opened. Show it in the folder instead.",
    );
  });

  it("will not open a macOS installer the model wrote", async () => {
    revealed = [];
    await writeFile(join(root, "install.pkg"), "payload");
    await writeFile(join(root, "suite.mpkg"), "payload");
    for (const path of [join(root, "install.pkg"), join(root, "suite.mpkg")]) {
      expect(
        await failureOf(handlers.revealPath({ conversationId: CONVERSATION, path, mode: "open" })),
      ).toBe("not-openable");
      await Effect.runPromise(
        handlers.revealPath({ conversationId: CONVERSATION, path, mode: "reveal" }),
      );
    }
    expect(revealed.map((call) => call.mode)).toEqual(["reveal", "reveal"]);

    await Effect.runPromise(
      handlers.revealPath({
        conversationId: CONVERSATION,
        path: join(root, "src", "index.ts"),
        mode: "open",
      }),
    );
    expect(revealed.at(-1)?.mode).toBe("open");
  });

  it("reports the operating system's refusal instead of claiming it opened", async () => {
    revealComplaint = "no application knows this file";
    expect(
      await failureOf(
        handlers.revealPath({
          conversationId: CONVERSATION,
          path: join(root, "src", "index.ts"),
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

  it("discards a conversation's workspace", async () => {
    await Effect.runPromise(handlers.discardWorkspace({ conversationId: BRANCH_CONVERSATION }));
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
