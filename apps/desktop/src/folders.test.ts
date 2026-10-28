import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exists, isOwnRealPath, resolveInFolder } from "./folders.ts";

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
    // Windows answers ENOENT below a file, where POSIX says ENOTDIR.
    if (process.platform === "win32") return;
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

describe("a pinned root", () => {
  it("is gone once a link replaces it, however recently it was checked", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "chat-pinned-")));
    const attached = join(base, "project");
    await mkdir(attached);
    await mkdir(join(base, "elsewhere"));
    const before = await Effect.runPromise(Effect.result(resolveInFolder(attached, ".", true)));
    expect(before._tag).toBe("Success");
    await rm(attached, { recursive: true });
    await symlink(join(base, "elsewhere"), attached);
    const after = await Effect.runPromise(Effect.result(resolveInFolder(attached, ".", true)));
    expect(after._tag === "Failure" && after.failure.reason).toBe("no-folder");
    // Unpinned (the workspace), the same root still resolves where it leads.
    expect((await Effect.runPromise(Effect.result(resolveInFolder(attached, "."))))._tag).toBe(
      "Success",
    );
    await rm(base, { recursive: true, force: true });
  });
});

describe("a real path", () => {
  it("is the path's own apart from the system's aliases, never where a link leads", () => {
    const project = resolve("/Users/a/project");
    expect(isOwnRealPath(`${project}/`, project)).toBe(true);
    expect(isOwnRealPath(project, resolve("/Users/a/elsewhere"))).toBe(false);
    if (process.platform === "darwin")
      expect(isOwnRealPath("/tmp/project", "/private/tmp/project")).toBe(true);
  });
});
