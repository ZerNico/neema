import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { DRAFT_CONVERSATION, LIMITS } from "@chat/desktop-rpc";
import { WorkspaceRegistry, workspacesRoot } from "./workspaces.ts";

const dirs: string[] = [];
const base = async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-workspaces-"));
  dirs.push(dir);
  return join(dir, "workspaces");
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const run = <A>(root: string, effect: Effect.Effect<A, unknown, WorkspaceRegistry>) =>
  Effect.runPromise(effect.pipe(Effect.provide(WorkspaceRegistry.layerEphemeral(root))));

describe("workspacesRoot", () => {
  it("keys the workspaces directory by an origin hash, not the origin", () => {
    const one = workspacesRoot("https://chat.one", "/data");
    const two = workspacesRoot("https://chat.two", "/data");
    expect(one).toMatch(/^\/data\/workspaces\/[0-9a-f]{16}$/);
    expect(two).toMatch(/^\/data\/workspaces\/[0-9a-f]{16}$/);
    expect(one).not.toBe(two);
  });
});

describe("WorkspaceRegistry", () => {
  it("imports a file, sanitizing and deduping the name", async () => {
    const root = await base();
    const imported = await run(root, Effect.gen(function* () {
      const workspaces = yield* WorkspaceRegistry;
      const first = yield* workspaces.importFile("conv", "../Report.PDF", new Uint8Array([1]));
      const second = yield* workspaces.importFile("conv", "Report.PDF", new Uint8Array([2, 3]));
      const size = yield* workspaces.size("conv");
      return { first, second, size };
    }));
    expect(imported.first.path).toBe("Report.PDF");
    expect(imported.second.path).toBe("Report-1.PDF");
    expect(imported.second.bytes).toBe(2);
    expect(await readFile(join(root, "conv", "Report-1.PDF"))).toEqual(Buffer.from([2, 3]));
    expect(imported.size).toBe(3);
  });

  it("refuses an import past the byte cap", async () => {
    const root = await base();
    const outcome = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        return yield* workspaces
          .importFile("conv", "huge.bin", new Uint8Array(LIMITS.importBytes + 1))
          .pipe(Effect.result);
      }),
    );
    expect(outcome._tag).toBe("Failure");
  });

  it("copies an import from a local path, deduped, without containing the source", async () => {
    const root = await base();
    const elsewhere = join(root, "..", "downloads");
    await mkdir(elsewhere, { recursive: true });
    const source = join(elsewhere, "dump.sql");
    await writeFile(source, "select 1;");
    const imported = await run(root, Effect.gen(function* () {
      const workspaces = yield* WorkspaceRegistry;
      // The point of the path import: the source sits outside every folder
      // the chat can see, and is copied in all the same.
      const first = yield* workspaces.importFileFromPath("conv", "../dump.sql", source);
      const second = yield* workspaces.importFileFromPath("conv", "dump.sql", source);
      return { first, second };
    }));
    expect(imported.first.path).toBe("dump.sql");
    expect(imported.second.path).toBe("dump-1.sql");
    expect(imported.first.bytes).toBe(9);
    expect(await readFile(join(root, "conv", "dump.sql"), "utf8")).toBe("select 1;");
    // The source is untouched: a copy, never a move.
    expect(await readFile(source, "utf8")).toBe("select 1;");
  });

  it("refuses a path import that is a folder or past the path cap", async () => {
    const root = await base();
    const big = join(root, "..", `big-${process.pid}.bin`);
    // Size only: the refusal must come from stat, so a sparse file proves it
    // without half a gigabyte on disk.
    await writeFile(big, new Uint8Array([1]));
    const { truncate } = await import("node:fs/promises");
    await truncate(big, LIMITS.importPathBytes + 1);
    const outcome = await run(root, Effect.gen(function* () {
      const workspaces = yield* WorkspaceRegistry;
      const folder = yield* workspaces
        .importFileFromPath("conv", "dir", root)
        .pipe(Effect.result);
      const huge = yield* workspaces
        .importFileFromPath("conv", "big.bin", big)
        .pipe(Effect.result);
      return { folder, huge };
    }));
    expect(outcome.folder._tag).toBe("Failure");
    expect(outcome.huge._tag).toBe("Failure");
    // Nothing landed: both refused before the workspace was even created.
    expect(await stat(join(root, "conv")).catch(() => null)).toBeNull();
  });

  it("discards an import by basename, never a path", async () => {
    const root = await base();
    await run(root, Effect.gen(function* () {
      const workspaces = yield* WorkspaceRegistry;
      yield* workspaces.importFile("conv", "keep.txt", new Uint8Array([1]));
      yield* workspaces.discardImport("conv", "../keep.txt");
      // Removing a file that is not there is not an error.
      yield* workspaces.discardImport("conv", "gone.txt");
    }));
    expect(await readdir(join(root, "conv"))).toEqual([]);
  });

  it("clones a workspace into a branch and refuses a non-empty destination", async () => {
    const root = await base();
    const second = await run(root, Effect.gen(function* () {
      const workspaces = yield* WorkspaceRegistry;
      yield* workspaces.importFile("source", "notes.md", new Uint8Array([1, 2]));
      yield* workspaces.clone("source", "branch");
      return yield* workspaces.clone("source", "branch").pipe(Effect.result);
    }));
    expect(await readFile(join(root, "branch", "notes.md"))).toEqual(Buffer.from([1, 2]));
    // The source keeps its copy.
    expect(await stat(join(root, "source", "notes.md"))).toBeTruthy();
    expect(second._tag).toBe("Failure");
  });

  it("moves the draft workspace onto the new conversation on rebind", async () => {
    const root = await base();
    await run(root, Effect.gen(function* () {
      const workspaces = yield* WorkspaceRegistry;
      yield* workspaces.importFile(DRAFT_CONVERSATION, "draft.txt", new Uint8Array([9]));
      yield* workspaces.rebind(DRAFT_CONVERSATION, "conv");
      // A second rebind after the move is a no-op, not an error.
      yield* workspaces.rebind(DRAFT_CONVERSATION, "conv");
    }));
    expect(await readFile(join(root, "conv", "draft.txt"))).toEqual(Buffer.from([9]));
    expect(await readdir(root)).toEqual(["conv"]);
  });

  it("discards a whole workspace, and reports size 0 for one that never existed", async () => {
    const root = await base();
    const layout = await run(root, Effect.gen(function* () {
      const workspaces = yield* WorkspaceRegistry;
      yield* workspaces.importFile("conv", "a.bin", new Uint8Array([1]));
      yield* workspaces.discard("conv");
      // `path` answers without creating anything.
      return { ghost: workspaces.path("ghost"), size: yield* workspaces.size("ghost") };
    }));
    expect(layout.ghost).toBe(join(root, "ghost"));
    expect(layout.size).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it("sweeps a draft workspace untouched for a week and keeps a fresh one", async () => {
    const root = await base();
    const stale = join(root, DRAFT_CONVERSATION);
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "old.txt"), "x");
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(stale, "old.txt"), weekAgo, weekAgo);
    await utimes(stale, weekAgo, weekAgo);

    await run(root, Effect.gen(function* () {
      const workspaces = yield* WorkspaceRegistry;
      yield* workspaces.sweepDrafts();
    }));
    expect((await readdir(root)).includes(DRAFT_CONVERSATION)).toBe(false);

    await run(root, Effect.gen(function* () {
      const workspaces = yield* WorkspaceRegistry;
      yield* workspaces.importFile(DRAFT_CONVERSATION, "fresh.txt", new Uint8Array([1]));
      yield* workspaces.sweepDrafts();
    }));
    expect(await readdir(join(root, DRAFT_CONVERSATION))).toEqual(["fresh.txt"]);
  });

  it("keeps conversations apart across origins in the layered registry", async () => {
    const root = await base();
    let origin = "https://chat.one";
    const data = join(root, "userData");
    const layer = WorkspaceRegistry.layerAt(() => origin, data);
    await Effect.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.importFile("shared", "one.txt", new Uint8Array([1]));
        origin = "https://chat.two";
        // The other origin sees no workspace for the same conversation id.
        expect(yield* workspaces.size("shared")).toBe(0);
        yield* workspaces.importFile("shared", "two.txt", new Uint8Array([2]));
        origin = "https://chat.one";
        expect(yield* workspaces.size("shared")).toBe(1);
      }).pipe(Effect.provide(layer)),
    );
  });
});
