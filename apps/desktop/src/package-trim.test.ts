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
  "@microsoft/mxc-sdk/dist/index.js",
  "@microsoft/mxc-sdk/bin/arm64/libmxc_ffi.dylib",
  "@microsoft/mxc-sdk/bin/arm64/libmxc_ffi.so",
  "@microsoft/mxc-sdk/bin/arm64/mxc_ffi.dll",
  "@microsoft/mxc-sdk/bin/arm64/mxc-exec-mac",
  "@microsoft/mxc-sdk/bin/arm64/wxc-exec.exe",
  "@microsoft/mxc-sdk/bin/arm64/_manifest/spdx.json",
  "@microsoft/mxc-sdk/bin/x64/mxc_ffi.dll",
  "@microsoft/mxc-sdk/bin/x64/libmxc_ffi.so",
  "@koromix/koffi-win32-x64/index.js",
  "@koromix/koffi-win32-arm64/index.js",
  "koffi/index.js",
  "node-pty/lib/index.js",
  "node-addon-api/index.js",
  "semver/index.js",
];

const listing = async (root: string) =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .toSorted();

it("keeps one platform's MXC library and koffi binding and drops node-pty", async () => {
  const root = await packaged(everything);
  await trimPackage(root, "win32", "arm64");
  expect(await listing(root)).toEqual(
    [
      "@koromix/koffi-win32-arm64/index.js",
      "@microsoft/mxc-sdk/bin/arm64/mxc_ffi.dll",
      "@microsoft/mxc-sdk/dist/index.js",
      "koffi/index.js",
      "semver/index.js",
    ].map((path) => join(path)),
  );
});

it("fails the build when the target's library or binding is missing", async () => {
  await expect(trimPackage(await packaged(everything), "darwin", "x64")).rejects.toThrow(
    "libmxc_ffi.dylib for x64 is missing",
  );
  await expect(trimPackage(await packaged(everything), "linux", "x64")).rejects.toThrow(
    "koffi's binding for linux-x64 is missing",
  );
});
