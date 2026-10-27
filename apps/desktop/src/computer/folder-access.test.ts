import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stillMountable } from "./folder-access.ts";

/** Real folders and a real link: a fake fs would pass a link it never followed. */
describe("stillMountable", () => {
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "neema-mount-")));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("keeps a folder that is still itself, and drops one swapped for a link", async () => {
    const appData = join(root, "app");
    const site = join(root, "site");
    const elsewhere = join(root, "elsewhere");
    for (const dir of [appData, site, elsewhere]) await mkdir(dir);
    expect(await stillMountable(site, appData)).toBe(true);

    await rm(site, { recursive: true });
    await symlink(elsewhere, site);
    expect(await stillMountable(site, appData)).toBe(false);

    await rm(site);
    expect(await stillMountable(site, appData)).toBe(false);
  });
});
