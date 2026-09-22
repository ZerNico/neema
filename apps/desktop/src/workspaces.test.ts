import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const SUBMISSION = "550e8400-e29b-41d4-a716-446655440000";
const SECOND_SUBMISSION = "550e8400-e29b-41d4-a716-446655440001";
const RESERVATION = "550e8400-e29b-41d4-a716-446655440002";
const SECOND_RESERVATION = "550e8400-e29b-41d4-a716-446655440003";

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

const addCommittedFile = (
  conversationId: string,
  submissionId: string,
  reservationId: string,
  name: string,
  bytes: Uint8Array,
) =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRegistry;
    yield* workspaces.stageFile(conversationId, submissionId, name, bytes);
    const promoted = yield* workspaces.promote(conversationId, submissionId, reservationId);
    yield* workspaces.commit(conversationId, reservationId);
    return promoted.files[0]!;
  });

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
  it("rejects unsafe workspace and transaction ids at the filesystem boundary", async () => {
    const root = await base();
    const outcomes = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        return yield* Effect.all([
          workspaces.ensure("../outside").pipe(Effect.result),
          workspaces
            .stageFile(CONVERSATION, "../submission", "x", new Uint8Array())
            .pipe(Effect.result),
          workspaces
            .stageFile("550e8400-e29b-41d4-a716-446655440000", SUBMISSION, "x", new Uint8Array())
            .pipe(Effect.result),
        ]);
      }),
    );
    expect(outcomes.every((outcome) => outcome._tag === "Failure")).toBe(true);
    expect(await stat(join(root, "..", "outside")).catch(() => null)).toBeNull();
  });

  it("stages bytes outside the workspace, sanitizing and atomically deduping names", async () => {
    const root = await base();
    const staged = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        return yield* Effect.all(
          [
            workspaces.stageFile(CONVERSATION, SUBMISSION, "../Report.PDF", new Uint8Array([1])),
            workspaces.stageFile(CONVERSATION, SUBMISSION, "Report.PDF", new Uint8Array([2, 3])),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );
    expect(staged.map((file) => file.name).sort()).toEqual(["Report-1.PDF", "Report.PDF"]);
    expect(await stat(join(root, CONVERSATION)).catch(() => null)).toBeNull();
    expect(await readdir(join(root, ".staging", CONVERSATION, SUBMISSION))).toEqual([
      "Report-1.PDF",
      "Report.PDF",
    ]);
  });

  it("refuses staged bytes past the base64 transport cap", async () => {
    const root = await base();
    const outcome = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        return yield* workspaces
          .stageFile(CONVERSATION, SUBMISSION, "huge.bin", new Uint8Array(LIMITS.importBytes + 1))
          .pipe(Effect.result);
      }),
    );
    expect(outcome._tag).toBe("Failure");
  });

  it("copies a host-path file into staging and leaves the source untouched", async () => {
    const root = await base();
    const downloads = join(root, "..", "downloads");
    await mkdir(downloads, { recursive: true });
    const source = join(downloads, "dump.sql");
    await writeFile(source, "select 1;");
    const receipt = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        return yield* workspaces.stageFileFromPath(CONVERSATION, SUBMISSION, "../dump.sql", source);
      }),
    );
    expect(receipt).toEqual({ name: "dump.sql", bytes: 9 });
    expect(
      await readFile(join(root, ".staging", CONVERSATION, SUBMISSION, "dump.sql"), "utf8"),
    ).toBe("select 1;");
    expect(await readFile(source, "utf8")).toBe("select 1;");
  });

  it("refuses a host-path folder or a file past the path cap", async () => {
    const root = await base();
    const sourceDir = join(root, "..", "downloads");
    const huge = join(root, "..", "huge.bin");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(huge, new Uint8Array([1]));
    await truncate(huge, LIMITS.importPathBytes + 1);
    const outcomes = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        return yield* Effect.all([
          workspaces
            .stageFileFromPath(CONVERSATION, SUBMISSION, "dir", sourceDir)
            .pipe(Effect.result),
          workspaces
            .stageFileFromPath(CONVERSATION, SUBMISSION, "huge.bin", huge)
            .pipe(Effect.result),
        ]);
      }),
    );
    expect(outcomes.every((outcome) => outcome._tag === "Failure")).toBe(true);
    expect(await stat(join(root, ".staging")).catch(() => null)).toBeNull();
  });

  it("discards one staged file by basename and then the whole submission", async () => {
    const root = await base();
    await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.stageFile(CONVERSATION, SUBMISSION, "keep.txt", new Uint8Array([1]));
        yield* workspaces.stageFile(CONVERSATION, SUBMISSION, "gone.txt", new Uint8Array([2]));
        yield* workspaces.discardStagedFile(CONVERSATION, SUBMISSION, "../gone.txt");
        yield* workspaces.discardStagedFile(CONVERSATION, SUBMISSION, "missing.txt");
      }),
    );
    expect(await readdir(join(root, ".staging", CONVERSATION, SUBMISSION))).toEqual(["keep.txt"]);
    await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.discardSubmission(CONVERSATION, SUBMISSION);
      }),
    );
    expect(
      await stat(join(root, ".staging", CONVERSATION, SUBMISSION)).catch(() => null),
    ).toBeNull();
  });

  it("promotes a complete batch, journals it, and commits without deleting workspace files", async () => {
    const root = await base();
    const result = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.stageFile(CONVERSATION, SUBMISSION, "a.txt", new Uint8Array([1]));
        yield* workspaces.stageFile(CONVERSATION, SUBMISSION, "b.txt", new Uint8Array([2]));
        const promoted = yield* workspaces.promote(CONVERSATION, SUBMISSION, RESERVATION);
        const repeated = yield* workspaces.promote(CONVERSATION, SUBMISSION, RESERVATION);
        const pending = yield* workspaces.pendingPromotions();
        yield* workspaces.commit(CONVERSATION, RESERVATION);
        return { promoted, repeated, pending };
      }),
    );
    expect(result.repeated).toEqual(result.promoted);
    expect(result.pending).toEqual([
      { conversationId: CONVERSATION, submissionId: SUBMISSION, reservationId: RESERVATION },
    ]);
    expect(await readdir(join(root, CONVERSATION))).toEqual(["a.txt", "b.txt"]);
    expect(
      await stat(join(root, ".staging", CONVERSATION, SUBMISSION)).catch(() => null),
    ).toBeNull();
    expect(await readdir(join(root, ".promotions"))).toEqual([]);
  });

  it("rolls a promotion back while preserving staging for retry", async () => {
    const root = await base();
    await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.stageFile(CONVERSATION, SUBMISSION, "a.txt", new Uint8Array([1]));
        yield* workspaces.promote(CONVERSATION, SUBMISSION, RESERVATION);
        yield* workspaces.rollback(CONVERSATION, RESERVATION);
      }),
    );
    expect(await readdir(join(root, CONVERSATION))).toEqual([]);
    expect(await readFile(join(root, ".staging", CONVERSATION, SUBMISSION, "a.txt"))).toEqual(
      Buffer.from([1]),
    );
    expect(await readdir(join(root, ".promotions"))).toEqual([]);
  });

  it("protects staged inodes needed to roll a promotion back", async () => {
    const root = await base();
    const outcome = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.stageFile(CONVERSATION, SUBMISSION, "a.txt", new Uint8Array([1]));
        yield* workspaces.promote(CONVERSATION, SUBMISSION, RESERVATION);
        const discard = yield* workspaces
          .discardStagedFile(CONVERSATION, SUBMISSION, "a.txt")
          .pipe(Effect.result);
        yield* workspaces.rollback(CONVERSATION, RESERVATION);
        return discard;
      }),
    );
    expect(outcome._tag).toBe("Failure");
    expect(await readdir(join(root, CONVERSATION))).toEqual([]);
    expect(await readFile(join(root, ".staging", CONVERSATION, SUBMISSION, "a.txt"))).toEqual(
      Buffer.from([1]),
    );
  });

  it("does not remove a promoted path that was replaced before rollback", async () => {
    const root = await base();
    await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.stageFile(CONVERSATION, SUBMISSION, "a.txt", new Uint8Array([1]));
        yield* workspaces.promote(CONVERSATION, SUBMISSION, RESERVATION);
      }),
    );
    const final = join(root, CONVERSATION, "a.txt");
    await rm(final);
    await writeFile(final, "replacement");
    await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.rollback(CONVERSATION, RESERVATION);
      }),
    );
    expect(await readFile(final, "utf8")).toBe("replacement");
  });

  it("keeps one unresolved promotion per workspace", async () => {
    const root = await base();
    const outcome = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.stageFile(CONVERSATION, SUBMISSION, "a.txt", new Uint8Array([1]));
        yield* workspaces.stageFile(CONVERSATION, SECOND_SUBMISSION, "b.txt", new Uint8Array([2]));
        yield* workspaces.promote(CONVERSATION, SUBMISSION, RESERVATION);
        return yield* workspaces
          .promote(CONVERSATION, SECOND_SUBMISSION, SECOND_RESERVATION)
          .pipe(Effect.result);
      }),
    );
    expect(outcome._tag).toBe("Failure");
  });

  it("clones committed files atomically and refuses a non-empty destination", async () => {
    const root = await base();
    const second = await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* addCommittedFile(
          CONVERSATION,
          SUBMISSION,
          RESERVATION,
          "notes.md",
          new Uint8Array([1, 2]),
        );
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
        yield* addCommittedFile(
          CONVERSATION,
          SUBMISSION,
          RESERVATION,
          "notes.md",
          new Uint8Array([1, 2]),
        );
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
        yield* addCommittedFile(
          CONVERSATION,
          SUBMISSION,
          RESERVATION,
          "a.bin",
          new Uint8Array([1]),
        );
        yield* workspaces.discard(CONVERSATION);
        return workspaces.path(OTHER);
      }),
    );
    expect(path).toBe(join(root, OTHER));
    expect(await stat(join(root, CONVERSATION)).catch(() => null)).toBeNull();
    expect(await stat(join(root, OTHER)).catch(() => null)).toBeNull();
  });

  it("sweeps stale unowned staging and clone partials but keeps fresh staging", async () => {
    const root = await base();
    const staleSubmission = join(root, ".staging", CONVERSATION, SUBMISSION);
    const freshSubmission = join(root, ".staging", CONVERSATION, SECOND_SUBMISSION);
    const partial = join(root, `.partial-${BRANCH}-old`);
    await mkdir(staleSubmission, { recursive: true });
    await mkdir(freshSubmission, { recursive: true });
    await mkdir(partial, { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(staleSubmission, old, old);
    await utimes(partial, old, old);
    await run(
      root,
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.sweepTransient();
      }),
    );
    expect(await stat(staleSubmission).catch(() => null)).toBeNull();
    expect(await stat(partial).catch(() => null)).toBeNull();
    expect(await stat(freshSubmission)).toBeTruthy();
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
