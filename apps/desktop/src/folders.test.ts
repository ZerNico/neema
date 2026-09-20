import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exists, resolveAmongRoots, resolveInFolder } from "./folders.ts";

/**
 * Real directories and real symlinks. A fake fs would let the containment check
 * pass on a symlink it never actually followed, which is the one failure this
 * boundary exists to prevent.
 */
let root: string;
let outsideDir: string;

const attempt = (requested: string) =>
  Effect.runPromise(Effect.result(resolveInFolder(root, requested)));

beforeAll(async () => {
  // realpath: macOS temp dirs are symlinked, and the resolver answers with the
  // real path, so the requests must be built from it.
  const base = await realpath(await mkdtemp(join(tmpdir(), "chat-folders-")));
  root = join(base, "workspace");
  outsideDir = join(base, "elsewhere");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export {}\n");
  await writeFile(join(outsideDir, "secrets.txt"), "token\n");
  await symlink(outsideDir, join(root, "escape"));
  await symlink(join(outsideDir, "secrets.txt"), join(root, "leak.txt"));
});

afterAll(async () => {
  await rm(resolve(root, ".."), { recursive: true, force: true });
});

describe("resolving a path inside the chosen folder", () => {
  it("accepts a file that is really inside", async () => {
    const outcome = await attempt("src/index.ts");

    expect(outcome._tag).toBe("Success");
    if (outcome._tag !== "Success") return;
    expect(outcome.success.relative).toBe(join("src", "index.ts"));
    expect(outcome.success.absolute.endsWith(join("src", "index.ts"))).toBe(true);
  });

  it("treats only ENOENT as missing, not an unreadable path", async () => {
    expect(await Effect.runPromise(exists(join(root, "missing")))).toBe(false);
    const outcome = await Effect.runPromise(
      Effect.result(exists(join(root, "src", "index.ts", "child"))),
    );
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { reason: "failed" } });
  });

  it("accepts the folder itself", async () => {
    const outcome = await attempt(".");

    expect(outcome._tag).toBe("Success");
    if (outcome._tag !== "Success") return;
    expect(outcome.success.relative).toBe(".");
  });

  it("accepts a file that does not exist yet, so a write can be checked", async () => {
    const outcome = await attempt("src/deeply/new/file.ts");

    expect(outcome._tag).toBe("Success");
    if (outcome._tag !== "Success") return;
    expect(outcome.success.relative).toBe(join("src", "deeply", "new", "file.ts"));
  });

  it("refuses a traversal out of the folder", async () => {
    for (const path of ["../elsewhere/secrets.txt", "src/../../elsewhere/secrets.txt", ".."]) {
      const outcome = await attempt(path);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag !== "Failure") continue;
      expect(outcome.failure.reason).toBe("outside-folder");
    }
  });

  it("accepts an absolute path that points inside", async () => {
    const outcome = await attempt(join(root, "src", "index.ts"));

    expect(outcome._tag).toBe("Success");
    if (outcome._tag !== "Success") return;
    expect(outcome.success.relative).toBe(join("src", "index.ts"));
  });

  it("refuses an absolute path that points outside", async () => {
    const outcome = await attempt(join(outsideDir, "secrets.txt"));

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") return;
    expect(outcome.failure.reason).toBe("outside-folder");
  });

  it("refuses a symlinked directory that leaves the folder", async () => {
    const outcome = await attempt("escape/secrets.txt");

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") return;
    expect(outcome.failure.reason).toBe("outside-folder");
  });

  it("refuses a symlinked file that leaves the folder", async () => {
    const outcome = await attempt("leak.txt");

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") return;
    expect(outcome.failure.reason).toBe("outside-folder");
  });

  it("refuses a write through a symlink that leaves the folder", async () => {
    const outcome = await attempt("escape/planted.txt");

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") return;
    expect(outcome.failure.reason).toBe("outside-folder");
  });

  it("does not resolve a dangling symlink to the host path", async () => {
    await symlink(join(outsideDir, "missing"), join(root, "dangling"));
    const outcome = await attempt("dangling");
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") return;
    expect(outcome.failure.reason).toBe("not-found");
    expect(outcome.failure.message).not.toContain(outsideDir);
    expect(outcome.failure.message).toContain("dangling");
  });

  it("reports a folder that has gone away rather than resolving against nothing", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(resolveInFolder(join(root, "does-not-exist"), "file.ts")),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") return;
    expect(outcome.failure.reason).toBe("no-folder");
  });
});

describe("resolving an absolute path among several roots", () => {
  // One root exists and one does not, the way the workspace dir is missing
  // until a write creates it: the live root answers, the missing one is
  // skipped rather than masking the live one with its own failure. Read lazily:
  // `root` is only set once the suite's beforeAll has run.
  const among = (requested: string) =>
    Effect.runPromise(
      Effect.result(
        resolveAmongRoots(
          [
            { name: "gone", root: join(root, "..", "not-yet-created") },
            { name: "workspace", root },
            { name: "elsewhere", root: outsideDir },
          ],
          requested,
        ),
      ),
    );

  it("picks the root that owns the path and names the receipt with it", async () => {
    const outcome = await among(join(root, "src", "index.ts"));
    expect(outcome._tag).toBe("Success");
    if (outcome._tag !== "Success") return;
    expect(outcome.success.relative).toBe("workspace/src/index.ts");
    expect(outcome.success.absolute.endsWith(join("src", "index.ts"))).toBe(true);
    expect(outcome.success.root.endsWith("workspace")).toBe(true);
  });

  it("resolves a root itself to its name", async () => {
    const outcome = await among(outsideDir);
    expect(outcome._tag).toBe("Success");
    if (outcome._tag !== "Success") return;
    expect(outcome.success.relative).toBe("elsewhere");
    expect(outcome.success.absolute).toBe(outcome.success.root);
  });

  it("refuses a relative path", async () => {
    const outcome = await among("src/index.ts");
    expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("outside-folder");
  });

  it("refuses an absolute path under no root", async () => {
    const outcome = await among("/etc/passwd");
    expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("outside-folder");
  });

  it("still refuses an escape through a symlink inside a root", async () => {
    const outcome = await among(join(root, "escape", "secrets.txt"));
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") return;
    expect(outcome.failure.reason).toBe("outside-folder");
    expect(outcome.failure.message).not.toContain(outsideDir);
  });
});
