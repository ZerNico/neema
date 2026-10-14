import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeCommandRoot } from "./command-root.ts";

const bases: string[] = [];
afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});
const base = async () => {
  const path = await mkdtemp(join(tmpdir(), "chat-command-root-"));
  bases.push(path);
  return path;
};

it("makes a fresh root when the system swept the old one away", async () => {
  const root = await makeCommandRoot(await base());
  const first = await root.current();
  expect(await root.current()).toBe(first);
  await rm(first, { recursive: true });
  const second = await root.current();
  expect(second).not.toBe(first);
  // Both stay off limits to path grants, and both go when the sandbox closes.
  expect(root.all()).toEqual([first, second]);
  await root.close();
});

for (const planted of ["a link", "a folder others can read"] as const)
  it.runIf(process.platform !== "win32")(
    `never reuses a swept root's name once ${planted} sits there`,
    async () => {
      const parent = await base();
      const root = await makeCommandRoot(parent);
      const first = await root.current();
      await rm(first, { recursive: true });
      // Another user could claim the swept name in a shared temporary folder.
      if (planted === "a link") {
        const elsewhere = join(parent, "elsewhere");
        await mkdir(elsewhere);
        await symlink(elsewhere, first);
      } else {
        await mkdir(first);
        await chmod(first, 0o755);
      }
      const next = await root.current();
      expect(next).not.toBe(first);
      expect(root.all()).toEqual([first, next]);
      if (planted === "a folder others can read") await writeFile(join(first, "theirs"), "x");
      await root.close();
      // What now sits at the old name is someone else's, and stays.
      expect((await lstat(first)).isSymbolicLink() || (await readdir(first)).length > 0).toBe(true);
      await expect(lstat(next)).rejects.toThrow("ENOENT");
    },
  );
