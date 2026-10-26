import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { trimPackage } from "./package-trim.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A packaged node_modules as electron-builder leaves it, with every platform's natives. */
const packaged = async (files: string[]) => {
  const root = await mkdtemp(join(tmpdir(), "chat-trim-"));
  roots.push(root);
  for (const file of files) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "");
  }
  return root;
};

const everything = [
  "microsandbox/dist/index.js",
  "@superradcompany/microsandbox-win32-x64-msvc/bin/msb.exe",
  "@superradcompany/microsandbox-win32-arm64-msvc/bin/msb.exe",
  "@superradcompany/microsandbox-linux-x64-gnu/bin/msb",
  "@superradcompany/other/index.js",
  "semver/index.js",
];

const listing = async (root: string) =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .toSorted();

it("keeps only the target's microsandbox package", async () => {
  const root = await packaged(everything);
  await trimPackage(root, "win32", "arm64");
  expect(await listing(root)).toEqual(
    [
      "@superradcompany/microsandbox-win32-arm64-msvc/bin/msb.exe",
      "@superradcompany/other/index.js",
      "microsandbox/dist/index.js",
      "semver/index.js",
    ].map((path) => join(path)),
  );
});

it("fails the build when the target's package is missing or unknown", async () => {
  await expect(trimPackage(await packaged(everything), "linux", "arm64")).rejects.toThrow(
    "microsandbox-linux-arm64-gnu is missing",
  );
  await expect(trimPackage(await packaged(everything), "darwin", "x64")).rejects.toThrow(
    "no native package for darwin-x64",
  );
});
