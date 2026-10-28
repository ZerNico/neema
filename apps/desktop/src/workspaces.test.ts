import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("@chat/desktop-rpc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@chat/desktop-rpc")>();
  return {
    ...original,
    LIMITS: { ...original.LIMITS, cloneEntries: 300 },
  };
});

import { LIMITS } from "@chat/desktop-rpc";
import { WorkspaceRegistry, workspacesRoot } from "./workspaces.ts";

const CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const BRANCH = "01990f4e-6650-7a33-a768-611e2e4bf4c8";
const OTHER = "01990f4e-6650-7a33-a768-611e2e4bf4c9";

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

const addFile = (conversationId: string, name: string, bytes: Uint8Array) =>
  Effect.flatMap(WorkspaceRegistry, (workspaces) =>
    workspaces.landFile(conversationId, name, bytes),
  );

describe("workspacesRoot", () => {
  it("keys the workspaces directory by an origin hash, not the origin", () => {
    const one = workspacesRoot("https://chat.one", "/data");
    const two = workspacesRoot("https://chat.two", "/data");
    for (const root of [one, two]) {
      expect(dirname(root)).toBe(join("/data", "workspaces"));
      expect(basename(root)).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(one).not.toBe(two);
  });
});

describe("WorkspaceRegistry", () => {
  it("rejects unsafe workspace ids at the filesystem boundary", async () => {
    const root = await base();
    const outcomes = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        return yield* Effect.all([
          workspaces.ensure("../outside").pipe(Effect.result),
          workspaces.landFile("../outside", "x", new Uint8Array()).pipe(Effect.result),
          workspaces
            .landFile("550e8400-e29b-41d4-a716-446655440000", "x", new Uint8Array())
            .pipe(Effect.result),
        ]);
      }),
    );
    expect(outcomes.every((outcome) => outcome._tag === "Failure")).toBe(true);
    expect(await stat(join(root, "..", "outside")).catch(() => null)).toBeNull();
  });

  it("lands bytes in the workspace, sanitizing and atomically deduping names", async () => {
    const root = await base();
    const landed = await run(
      root,
      Effect.all(
        [
          addFile(CONVERSATION, "../Report.PDF", new Uint8Array([1])),
          addFile(CONVERSATION, "Report.PDF", new Uint8Array([2, 3])),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(landed.map((file) => file.name).toSorted()).toEqual(["Report-1.PDF", "Report.PDF"]);
    expect(await readdir(join(root, CONVERSATION))).toEqual(["Report-1.PDF", "Report.PDF"]);
  });

  it("clones a workspace atomically and refuses a non-empty destination", async () => {
    const root = await base();
    const second = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* addFile(CONVERSATION, "notes.md", new Uint8Array([1, 2]));
        yield* workspaces.clone(CONVERSATION, BRANCH);
        return yield* workspaces.clone(CONVERSATION, BRANCH).pipe(Effect.result);
      }),
    );
    expect(await readFile(join(root, BRANCH, "notes.md"))).toEqual(Buffer.from([1, 2]));
    expect(await stat(join(root, CONVERSATION, "notes.md"))).toBeTruthy();
    expect(second._tag).toBe("Failure");
    expect((await readdir(root)).some((name) => name.startsWith(".partial-"))).toBe(false);
  });

  it("refuses to publish a clone over an empty destination", async () => {
    const root = await base();
    const outcome = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* addFile(CONVERSATION, "notes.md", new Uint8Array([1, 2]));
        yield* workspaces.ensure(BRANCH);
        return yield* workspaces.clone(CONVERSATION, BRANCH).pipe(Effect.result);
      }),
    );
    expect(outcome._tag).toBe("Failure");
    expect(await readdir(join(root, BRANCH))).toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith(".partial-"))).toBe(false);
  });

  it("refuses a clone beyond the independent nesting cap", async () => {
    const root = await base();
    let current = join(root, CONVERSATION);
    await mkdir(current, { recursive: true });
    for (let depth = 0; depth <= LIMITS.cloneDepth; depth += 1) {
      current = join(current, "a");
      await mkdir(current);
    }
    await writeFile(join(current, "deep.txt"), "x");
    const outcome = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        return yield* workspaces.clone(CONVERSATION, BRANCH).pipe(Effect.result);
      }),
    );
    expect(outcome._tag).toBe("Failure");
    expect(await stat(join(root, BRANCH)).catch(() => null)).toBeNull();
  });

  it("refuses a clone beyond the independent visited-entry cap", async () => {
    const root = await base();
    const source = join(root, CONVERSATION);
    await mkdir(source, { recursive: true });
    await Promise.all(
      Array.from({ length: LIMITS.cloneEntries + 1 }, (_, index) =>
        writeFile(join(source, `${index}.txt`), "x"),
      ),
    );
    const outcome = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        return yield* workspaces.clone(CONVERSATION, BRANCH).pipe(Effect.result);
      }),
    );
    expect(outcome._tag).toBe("Failure");
    expect(await stat(join(root, BRANCH)).catch(() => null)).toBeNull();
  });

  it("discards a workspace and returns its path without creating it", async () => {
    const root = await base();
    const path = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* addFile(CONVERSATION, "a.bin", new Uint8Array([1]));
        yield* workspaces.discard(CONVERSATION);
        return workspaces.path(OTHER);
      }),
    );
    expect(path).toBe(join(root, OTHER));
    expect(await stat(join(root, CONVERSATION)).catch(() => null)).toBeNull();
    expect(await stat(join(root, OTHER)).catch(() => null)).toBeNull();
  });

  it("sweeps stale clone partials and what composer staging left behind", async () => {
    const root = await base();
    const staging = join(root, ".staging", CONVERSATION);
    const journals = join(root, ".promotions");
    const stalePartial = join(root, `.partial-${BRANCH}-old`);
    const freshPartial = join(root, `.partial-${BRANCH}-new`);
    for (const dir of [staging, journals, stalePartial, freshPartial])
      await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(stalePartial, old, old);
    await run(
      root,
      Effect.flatMap(WorkspaceRegistry, (workspaces) => workspaces.sweepTransient()),
    );
    expect(await readdir(root)).toEqual([`.partial-${BRANCH}-new`]);
  });

  it("keeps conversations apart across origins in the layered registry", async () => {
    const root = await base();
    let origin = "https://chat.one";
    const data = join(root, "userData");
    const layer = WorkspaceRegistry.layerAt(() => origin, data);
    await Effect.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.ensure(CONVERSATION);
        origin = "https://chat.two";
        expect(
          yield* Effect.promise(() => stat(workspaces.path(CONVERSATION)).catch(() => null)),
        ).toBeNull();
        yield* workspaces.ensure(CONVERSATION);
        origin = "https://chat.one";
        expect(yield* Effect.promise(() => stat(workspaces.path(CONVERSATION)))).toBeTruthy();
      }).pipe(Effect.provide(layer)),
    );
  });
});
