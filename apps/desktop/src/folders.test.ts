import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exists, resolveAcross, resolveInFolder } from "./folders.ts";

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
  const base = await mkdtemp(join(tmpdir(), "chat-folders-"));
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

  it("refuses an absolute path even when it points inside", async () => {
    const outcome = await attempt(join(root, "src", "index.ts"));

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

  it("reports a folder that has gone away rather than resolving against nothing", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(resolveInFolder(join(root, "does-not-exist"), "file.ts")),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") return;
    expect(outcome.failure.reason).toBe("no-folder");
  });
});

describe("resolving a path across several attached folders", () => {
  const across = (requested: string) =>
    Effect.runPromise(Effect.result(resolveAcross([root, outsideDir], requested)));

  it("routes by the first segment and names the result with the prefix", async () => {
    const outcome = await across("workspace/src/index.ts");
    expect(outcome._tag).toBe("Success");
    if (outcome._tag !== "Success") return;
    expect(outcome.success.relative).toBe("workspace/src/index.ts");
    expect(outcome.success.absolute.endsWith(join("src", "index.ts"))).toBe(true);
    expect(outcome.success.root.endsWith("workspace")).toBe(true);
  });

  it("resolves a bare folder name to its root", async () => {
    const outcome = await across("elsewhere");
    expect(outcome._tag).toBe("Success");
    if (outcome._tag !== "Success") return;
    expect(outcome.success.relative).toBe("elsewhere");
    expect(outcome.success.absolute).toBe(outcome.success.root);
  });

  it("refuses a path that names no attached folder", async () => {
    const outcome = await across("src/index.ts");
    expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("not-found");
  });

  it("still refuses an escape through a symlink inside a named folder", async () => {
    const outcome = await across("workspace/escape/secrets.txt");
    expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("outside-folder");
  });

  it("refuses crossing from one folder into another with ..", async () => {
    const outcome = await across("workspace/../elsewhere/secrets.txt");
    expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("outside-folder");
  });
});
