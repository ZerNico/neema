import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DesktopHandlers } from "@chat/desktop-rpc";
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
let revealed: string[];
let ran: { command: string; cwd: string }[];

const CONVERSATION = "conv-1";

/** Never runs anything: these tests are about the path boundary, not the sandbox. */
const stubSandbox = Layer.succeed(
  Sandbox,
  Sandbox.of({
    availability: () => Effect.succeed({ kind: "ready" as const }),
    setUp: () => Effect.succeed({ kind: "ready" as const }),
    run: ({ command, cwd }) =>
      Effect.sync(() => {
        ran.push({ command, cwd });
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
    reveal: async (absolute) => void revealed.push(absolute),
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
  revealed = [];
  ran = [];
});

describe("before a folder is attached", () => {
  it("refuses every request that would touch disk", async () => {
    const fresh = "conv-untouched";
    expect(
      await failureOf(handlers.readFile({ conversationId: fresh, path: "src/index.ts" })),
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
          timeoutMs: 1000,
        }),
      ),
    ).toBe("no-folder");
  });

  it("reports no folder rather than inventing one", async () => {
    const state = await Effect.runPromise(
      handlers.folderStatus({ conversationId: "conv-untouched" }),
    );
    expect(state.kind).toBe("none");
  });
});

describe("once a folder is attached", () => {
  beforeAll(attach);

  it("reports the folder by name, never by path", async () => {
    const state = await Effect.runPromise(handlers.folderStatus({ conversationId: CONVERSATION }));

    expect(state.kind).toBe("attached");
    if (state.kind !== "attached") return;
    expect(state.name).toBe("workspace");
    expect(JSON.stringify(state)).not.toContain(root);
  });

  it("reads and writes inside it", async () => {
    const contents = await Effect.runPromise(
      handlers.readFile({ conversationId: CONVERSATION, path: "src/index.ts" }),
    );
    expect(contents.text).toBe("export {}\n");

    const receipt = await Effect.runPromise(
      handlers.writeFile({
        conversationId: CONVERSATION,
        path: "src/new/note.md",
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
      await failureOf(handlers.readFile({ conversationId: CONVERSATION, path: "src/logo.png" })),
    ).toBe("not-text");
  });

  it("reads an image as bytes and refuses anything else", async () => {
    const image = await Effect.runPromise(
      handlers.readBinary({ conversationId: CONVERSATION, path: "src/logo.png" }),
    );
    expect(image.mediaType).toBe("image/png");
    expect(Buffer.from(image.base64, "base64")[0]).toBe(0x89);
    expect(
      await failureOf(handlers.readBinary({ conversationId: CONVERSATION, path: "src/index.ts" })),
    ).toBe("not-binary");
  });

  it("edits by exact unique match and returns the diff", async () => {
    await writeFile(join(root, "src", "edit.ts"), "const a = 1;\nconst b = 1;\nconst c = 2;\n");
    expect(
      await failureOf(
        handlers.editFile({
          conversationId: CONVERSATION,
          path: "src/edit.ts",
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
          path: "src/edit.ts",
          old: "const z",
          new: "x",
          all: false,
        }),
      ),
    ).toBe("no-match");

    const receipt = await Effect.runPromise(
      handlers.editFile({
        conversationId: CONVERSATION,
        path: "src/edit.ts",
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
        path: "src/edit.ts",
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
          from: "src/old.txt",
          to: "src/taken.txt",
        }),
      ),
    ).toBe("already-exists");
    expect(
      await failureOf(
        handlers.movePath({ conversationId: CONVERSATION, from: "src/old.txt", to: "../away.txt" }),
      ),
    ).toBe("outside-folder");
    const moved = await Effect.runPromise(
      handlers.movePath({
        conversationId: CONVERSATION,
        from: "src/old.txt",
        to: "src/sub/new.txt",
      }),
    );
    expect(moved).toEqual({ from: "src/old.txt", to: "src/sub/new.txt" });
    expect(await readFile(join(root, "src", "sub", "new.txt"), "utf8")).toBe("x");

    const gone = await Effect.runPromise(
      handlers.deletePath({ conversationId: CONVERSATION, path: "src/sub" }),
    );
    expect(gone.kind).toBe("directory");
    expect(
      await failureOf(handlers.readFile({ conversationId: CONVERSATION, path: "src/sub/new.txt" })),
    ).toBe("not-found");
    expect(await failureOf(handlers.deletePath({ conversationId: CONVERSATION, path: "." }))).toBe(
      "outside-folder",
    );
  });

  it("finds by glob and searches by regex, ignoring what git ignores", async () => {
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await mkdir(join(root, "ignored"), { recursive: true });
    await writeFile(join(root, "ignored", "noise.ts"), "needle");
    await writeFile(join(root, "src", "hay.ts"), "no\nneedle here\nno");

    const found = await Effect.runPromise(
      handlers.findFiles({ conversationId: CONVERSATION, pattern: "*.ts" }),
    );
    expect(found.paths).toContain("src/hay.ts");
    expect(found.paths).not.toContain("ignored/noise.ts");

    const hits = await Effect.runPromise(
      handlers.searchFiles({ conversationId: CONVERSATION, pattern: "needle", glob: "src/**" }),
    );
    expect(hits.matches).toEqual([{ path: "src/hay.ts", line: 2, text: "needle here" }]);
    expect(hits.filesSearched).toBeGreaterThan(0);
    expect(
      await failureOf(handlers.searchFiles({ conversationId: CONVERSATION, pattern: "(" })),
    ).toBe("bad-pattern");
  });

  it("refuses to read or write through a symlink that leaves it", async () => {
    expect(
      await failureOf(
        handlers.readFile({ conversationId: CONVERSATION, path: "escape/secrets.txt" }),
      ),
    ).toBe("outside-folder");
    expect(
      await failureOf(
        handlers.writeFile({
          conversationId: CONVERSATION,
          path: "escape/planted.txt",
          text: "x",
        }),
      ),
    ).toBe("outside-folder");
  });

  it("refuses a traversal and an absolute path", async () => {
    expect(
      await failureOf(
        handlers.readFile({ conversationId: CONVERSATION, path: "../elsewhere/secrets.txt" }),
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
        timeoutMs: 1000,
      }),
    );

    expect(ran).toHaveLength(1);
    expect(ran[0]?.cwd).toBe(await Effect.runPromise(realRoot()));
  });

  it("forgets the folder on request", async () => {
    await Effect.runPromise(handlers.detachFolder({ conversationId: CONVERSATION }));

    const state = await Effect.runPromise(handlers.folderStatus({ conversationId: CONVERSATION }));
    expect(state.kind).toBe("none");
    await attach();
  });
});

/** The handler resolves symlinks, so the temp dir's real path is what it uses. */
const realRoot = () =>
  Effect.promise(async () => {
    const { realpath } = await import("node:fs/promises");
    return realpath(root);
  });
