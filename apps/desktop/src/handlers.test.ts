import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { vi } from "vitest";

// Whether `rg` answers is decided per test, so both backends are proven
// against the same folder and the same expectations.
const ripgrep = vi.hoisted(() => ({ present: true }));
vi.mock("./ripgrep.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ripgrep.ts")>();
  return {
    ...original,
    ripgrepAvailable: () => original.ripgrepAvailable().then((real) => real && ripgrep.present),
  };
});
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDesktopResponder, type DesktopHandlers } from "@chat/desktop-rpc";
import { makeExecutions } from "./executions.ts";
import { GrantStore } from "./grants.ts";
import { makeHandlers, type Shell } from "./handlers.ts";
import { Sandbox } from "./sandbox.ts";

/**
 * The handlers are the layer a compromised or confused caller actually reaches,
 * so containment is asserted here too and not only against `resolveInFolder`.
 * A handler that forgot to resolve would pass those unit tests and fail these.
 */
let root: string;
let outsideDir: string;
let handlers: DesktopHandlers;
let picked: string | null;
let ran: { command: string; cwd: string; network: string; allowWrite: string[] }[];
let revealed: { absolute: string; mode: string }[];
/** What the operating system complained about, when the test wants it to. */
let revealComplaint: string | null;

const CONVERSATION = "conv-1";

/** Never runs anything: these tests are about the path boundary, not the sandbox. */
const stubSandbox = Layer.succeed(
  Sandbox,
  Sandbox.of({
    availability: () => Effect.succeed({ kind: "ready" as const }),
    setUp: () => Effect.succeed({ kind: "ready" as const }),
    run: ({ command, cwd, network, allowWrite }) =>
      Effect.sync(() => {
        ran.push({ command, cwd, network, allowWrite: [...allowWrite] });
        return { exitCode: 0, output: "", truncated: false, violations: [] };
      }),
  }),
);

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "chat-handlers-"));
  root = join(base, "workspace");
  outsideDir = join(base, "elsewhere");
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
    executionSession: () => ({ id: "test-session" }),
    cancelCall: () => false,
    setWorkState: () => {},
  };

  handlers = await Effect.runPromise(
    makeHandlers(shell).pipe(
      Effect.provide(Layer.mergeAll(GrantStore.layerEphemeral, stubSandbox)),
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
  it("refuses every request that would touch disk", async () => {
    const fresh = "conv-untouched";
    expect(
      await failureOf(handlers.readFile({ conversationId: fresh, path: "workspace/src/index.ts" })),
    ).toBe("no-folder");
    expect(await failureOf(handlers.listDirectory({ conversationId: fresh, path: "." }))).toBe(
      "no-folder",
    );
    expect(
      await failureOf(
        handlers.runCommand({
          conversationId: fresh,
          callId: "c",
          command: "echo hi",
          folder: "workspace",
          timeoutMs: 1000,
          network: "packages",
        }),
      ),
    ).toBe("no-folder");
  });

  it("reports no folder rather than inventing one", async () => {
    const state = await Effect.runPromise(
      handlers.folderStatus({ conversationId: "conv-untouched" }),
    );
    expect(state.folders).toEqual([]);
  });
});

describe("once a folder is attached", () => {
  beforeAll(attach);

  it("reports the folder by name, never by path", async () => {
    const state = await Effect.runPromise(handlers.folderStatus({ conversationId: CONVERSATION }));

    expect(state.folders).toEqual([{ name: "workspace", alive: true }]);
    expect(JSON.stringify(state)).not.toContain(root);
  });

  it("reads and writes inside it", async () => {
    const contents = await Effect.runPromise(
      handlers.readFile({ conversationId: CONVERSATION, path: "workspace/src/index.ts" }),
    );
    expect(contents.text).toBe("export {}\n");

    const receipt = await Effect.runPromise(
      handlers.writeFile({
        conversationId: CONVERSATION,
        path: "workspace/src/new/note.md",
        text: "hello",
      }),
    );
    expect(receipt.created).toBe(true);
    expect(await readFile(join(root, "src", "new", "note.md"), "utf8")).toBe("hello");
  });

  it("refuses to read a binary file as text", async () => {
    await writeFile(
      join(root, "src", "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]),
    );
    expect(
      await failureOf(
        handlers.readFile({ conversationId: CONVERSATION, path: "workspace/src/logo.png" }),
      ),
    ).toBe("not-text");
  });

  it("reads an image as bytes and refuses anything else", async () => {
    const image = await Effect.runPromise(
      handlers.readBinary({ conversationId: CONVERSATION, path: "workspace/src/logo.png" }),
    );
    expect(image.mediaType).toBe("image/png");
    expect(Buffer.from(image.base64, "base64")[0]).toBe(0x89);
    expect(
      await failureOf(
        handlers.readBinary({ conversationId: CONVERSATION, path: "workspace/src/index.ts" }),
      ),
    ).toBe("not-binary");
  });

  it("edits by exact unique match and returns the diff", async () => {
    await writeFile(join(root, "src", "edit.ts"), "const a = 1;\nconst b = 1;\nconst c = 2;\n");
    expect(
      await failureOf(
        handlers.editFile({
          conversationId: CONVERSATION,
          path: "workspace/src/edit.ts",
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
          path: "workspace/src/edit.ts",
          old: "const z",
          new: "x",
          all: false,
        }),
      ),
    ).toBe("no-match");

    const receipt = await Effect.runPromise(
      handlers.editFile({
        conversationId: CONVERSATION,
        path: "workspace/src/edit.ts",
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
        path: "workspace/src/edit.ts",
        old: "= 1;",
        new: "= 0;",
        all: true,
      }),
    );
    expect(every.replacements).toBe(2);
  });

  it("moves without overwriting and deletes, but never the folder itself", async () => {
    await writeFile(join(root, "src", "old.txt"), "x");
    await writeFile(join(root, "src", "taken.txt"), "y");
    expect(
      await failureOf(
        handlers.movePath({
          conversationId: CONVERSATION,
          from: "workspace/src/old.txt",
          to: "workspace/src/taken.txt",
        }),
      ),
    ).toBe("already-exists");
    expect(
      await failureOf(
        handlers.movePath({
          conversationId: CONVERSATION,
          from: "workspace/src/old.txt",
          to: "workspace/../away.txt",
        }),
      ),
    ).toBe("outside-folder");
    const moved = await Effect.runPromise(
      handlers.movePath({
        conversationId: CONVERSATION,
        from: "workspace/src/old.txt",
        to: "workspace/src/sub/new.txt",
      }),
    );
    expect(moved).toEqual({ from: "workspace/src/old.txt", to: "workspace/src/sub/new.txt" });
    expect(await readFile(join(root, "src", "sub", "new.txt"), "utf8")).toBe("x");

    const gone = await Effect.runPromise(
      handlers.deletePath({ conversationId: CONVERSATION, path: "workspace/src/sub" }),
    );
    expect(gone.kind).toBe("directory");
    expect(
      await failureOf(
        handlers.readFile({ conversationId: CONVERSATION, path: "workspace/src/sub/new.txt" }),
      ),
    ).toBe("not-found");
    expect(
      await failureOf(handlers.deletePath({ conversationId: CONVERSATION, path: "workspace" })),
    ).toBe("outside-folder");
  });

  it.each([true, false])(
    "finds by glob and searches by regex, ignoring what git ignores (ripgrep: %s)",
    async (withRipgrep) => {
      ripgrep.present = withRipgrep;
      await writeFile(join(root, ".gitignore"), "ignored/\n");
      await mkdir(join(root, "ignored"), { recursive: true });
      await writeFile(join(root, "ignored", "noise.ts"), "needle");
      await writeFile(join(root, "src", "hay.ts"), "no\nneedle here\nno");

      const found = await Effect.runPromise(
        handlers.findFiles({ conversationId: CONVERSATION, pattern: "*.ts" }),
      );
      expect(found.paths).toContain("workspace/src/hay.ts");
      expect(found.paths).not.toContain("workspace/ignored/noise.ts");

      const hits = await Effect.runPromise(
        handlers.searchFiles({
          conversationId: CONVERSATION,
          pattern: "needle",
          glob: "workspace/src/**",
        }),
      );
      expect(hits.matches).toEqual([
        { path: "workspace/src/hay.ts", line: 2, text: "needle here" },
      ]);
      expect(hits.filesSearched).toBeGreaterThan(0);
      expect(
        await failureOf(handlers.searchFiles({ conversationId: CONVERSATION, pattern: "(" })),
      ).toBe("bad-pattern");
    },
  );

  it("refuses to read or write through a symlink that leaves it", async () => {
    expect(
      await failureOf(
        handlers.readFile({ conversationId: CONVERSATION, path: "workspace/escape/secrets.txt" }),
      ),
    ).toBe("outside-folder");
    expect(
      await failureOf(
        handlers.writeFile({
          conversationId: CONVERSATION,
          path: "workspace/escape/planted.txt",
          text: "x",
        }),
      ),
    ).toBe("outside-folder");
  });

  it("never writes an outside target through a dangling symlink", async () => {
    const target = join(outsideDir, "not-created.txt");
    await symlink(target, join(root, "dangling"));
    expect(
      await failureOf(
        handlers.writeFile({
          conversationId: CONVERSATION,
          path: "workspace/dangling",
          text: "escaped",
        }),
      ),
    ).toBe("not-found");
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });

    await symlink(join(outsideDir, "missing-directory"), join(root, "dangling-dir"));
    expect(
      await failureOf(
        handlers.writeFile({
          conversationId: CONVERSATION,
          path: "workspace/dangling-dir/nested.txt",
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
        path: "workspace/literal.txt",
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
      path: "workspace/replay.txt",
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
        path: "workspace/src/index.ts",
        mode: "reveal",
      }),
    );
    const real = await Effect.runPromise(realRoot());
    expect(revealed).toEqual([{ absolute: join(real, "src", "index.ts"), mode: "reveal" }]);

    // Same containment as every other file procedure, because the click comes
    // from the same remote page the model's calls come from.
    for (const path of [
      "workspace/../elsewhere/secrets.txt",
      "workspace/escape/secrets.txt",
      "elsewhere/secrets.txt",
    ]) {
      expect(
        await failureOf(handlers.revealPath({ conversationId: CONVERSATION, path, mode: "open" })),
      ).not.toBe("unexpected success");
    }
    expect(
      await failureOf(
        handlers.revealPath({
          conversationId: CONVERSATION,
          path: join(outsideDir, "secrets.txt"),
          mode: "reveal",
        }),
      ),
    ).toBe("outside-folder");
    expect(
      await failureOf(
        handlers.revealPath({
          conversationId: CONVERSATION,
          path: "workspace/src/nothing-here.txt",
          mode: "reveal",
        }),
      ),
    ).toBe("not-found");
    // A dangling symlink resolves to nothing, so it can never be handed over.
    expect(
      await failureOf(
        handlers.revealPath({
          conversationId: CONVERSATION,
          path: "workspace/dangling",
          mode: "open",
        }),
      ),
    ).toBe("not-found");
    expect(revealed).toHaveLength(1);
  });

  it("will not hand a file this computer would run to its default application", async () => {
    revealed = [];
    await writeFile(join(root, "install.command"), "rm -rf /\n");
    await writeFile(join(root, "drawing.svg"), "<svg onload=\"alert(1)\"></svg>");
    await writeFile(join(root, "runme"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    for (const path of ["workspace/install.command", "workspace/drawing.svg", "workspace/runme"]) {
      expect(
        await failureOf(handlers.revealPath({ conversationId: CONVERSATION, path, mode: "open" })),
      ).toBe("not-openable");
      // Showing it in the folder is the answer offered instead, so it must work.
      await Effect.runPromise(
        handlers.revealPath({ conversationId: CONVERSATION, path, mode: "reveal" }),
      );
    }
    expect(revealed.map((call) => call.mode)).toEqual(["reveal", "reveal", "reveal"]);

    // Two causes, two sentences. The site hides Open for the extension list,
    // so the executable one is the refusal a reader can still reach.
    const refusalFor = async (path: string) => {
      const outcome = await Effect.runPromise(
        Effect.result(handlers.revealPath({ conversationId: CONVERSATION, path, mode: "open" })),
      );
      return outcome._tag === "Failure" ? outcome.failure.message : "unexpected success";
    };
    expect(await refusalFor("workspace/runme")).toBe(
      "workspace/runme is marked executable, so opening it could run it. Show it in the folder instead.",
    );
    expect(await refusalFor("workspace/drawing.svg")).toBe(
      "workspace/drawing.svg is a kind of file that can run when it is opened. Show it in the folder instead.",
    );

    await Effect.runPromise(
      handlers.revealPath({
        conversationId: CONVERSATION,
        path: "workspace/src/index.ts",
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
          path: "workspace/src/index.ts",
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
      await ask({ conversationId: CONVERSATION, path: "workspace/src/index.ts", mode: "reveal" }),
    ).toEqual({ ok: true, value: undefined });
    expect(revealed).toHaveLength(1);

    expect(
      await ask({ conversationId: CONVERSATION, path: "workspace/src/index.ts", mode: "launch" }),
    ).toMatchObject({ ok: false, error: { reason: "failed" } });
    expect(
      await ask({ conversationId: CONVERSATION, path: "workspace/escape/secrets.txt", mode: "open" }),
    ).toMatchObject({ ok: false, error: { reason: "outside-folder" } });
    expect(revealed).toHaveLength(1);
  });

  it("refuses a traversal and an absolute path", async () => {
    expect(
      await failureOf(
        handlers.readFile({
          conversationId: CONVERSATION,
          path: "workspace/../elsewhere/secrets.txt",
        }),
      ),
    ).toBe("outside-folder");
    expect(
      await failureOf(
        handlers.readFile({ conversationId: CONVERSATION, path: join(outsideDir, "secrets.txt") }),
      ),
    ).toBe("outside-folder");
  });

  it("runs a command with the folder as its only writable path", async () => {
    ran = [];
    await Effect.runPromise(
      handlers.runCommand({
        conversationId: CONVERSATION,
        callId: "call-1",
        command: "echo hi",
        folder: "workspace",
        timeoutMs: 1000,
        network: "packages",
      }),
    );

    expect(ran).toHaveLength(1);
    expect(ran[0]?.cwd).toBe(await Effect.runPromise(realRoot()));
    // The level is the chat's, carried down per call; the desktop stores none.
    expect(ran[0]?.network).toBe("packages");
  });

  it("attaches a second folder, addresses both by name, and refuses a name clash", async () => {
    picked = outsideDir;
    const two = await Effect.runPromise(handlers.chooseFolder({ conversationId: CONVERSATION }));
    expect(two.folders.map((folder) => folder.name)).toEqual(["workspace", "elsewhere"]);

    // The root of the model's world is the list of folders.
    const top = await Effect.runPromise(
      handlers.listDirectory({ conversationId: CONVERSATION, path: "." }),
    );
    expect(top.entries.map((entry) => entry.name)).toEqual(["workspace", "elsewhere"]);
    // A plain file carries its size, so an empty extensionless file is not
    // mistaken for a folder.
    const inside = await Effect.runPromise(
      handlers.listDirectory({ conversationId: CONVERSATION, path: "elsewhere" }),
    );
    expect(inside.entries).toContainEqual({ name: "secrets.txt", kind: "file", size: 6 });

    // Each folder answers under its own name, and neither can see the other
    // except by name.
    const secret = await Effect.runPromise(
      handlers.readFile({ conversationId: CONVERSATION, path: "elsewhere/secrets.txt" }),
    );
    expect(secret.text).toBe("token\n");
    expect(
      await failureOf(
        handlers.readFile({
          conversationId: CONVERSATION,
          path: "workspace/../elsewhere/secrets.txt",
        }),
      ),
    ).toBe("outside-folder");

    // A command runs in the named folder and may write to every attached one.
    ran = [];
    await Effect.runPromise(
      handlers.runCommand({
        conversationId: CONVERSATION,
        callId: "call-3",
        command: "echo hi",
        folder: "elsewhere",
        timeoutMs: 1000,
        network: "packages",
      }),
    );
    expect(ran[0]?.cwd.endsWith("elsewhere")).toBe(true);
    expect(ran[0]?.allowWrite).toHaveLength(2);

    // A different folder with the same name would be unaddressable.
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
      handlers.detachFolder({ conversationId: CONVERSATION, name: "workspace" }),
    );

    const state = await Effect.runPromise(handlers.folderStatus({ conversationId: CONVERSATION }));
    expect(state.folders).toEqual([]);
    await attach();
  });
});

/** The handler resolves symlinks, so the temp dir's real path is what it uses. */
const realRoot = () =>
  Effect.promise(async () => {
    const { realpath } = await import("node:fs/promises");
    return realpath(root);
  });
