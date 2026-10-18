import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";

const barriers = vi.hoisted(() => ({
  afterWrite: null as (() => Promise<void>) | null,
  beforeLink: null as (() => void) | null,
  links: 0,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      await barriers.afterWrite?.();
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      barriers.links++;
      barriers.beforeLink?.();
      return fs.link(...args);
    },
  };
});
import { WorkspaceRegistry } from "./workspaces.ts";

const dirs: string[] = [];
const CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "neema-land-cancel-"));
  dirs.push(root);
  const registry = await Effect.runPromise(
    WorkspaceRegistry.pipe(Effect.provide(WorkspaceRegistry.layerEphemeral(root))),
  );
  await Effect.runPromise(registry.ensure(CONVERSATION));
  return registry;
};

afterEach(async () => {
  barriers.afterWrite = null;
  barriers.beforeLink = null;
  barriers.links = 0;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("cancels after writing temp bytes but before workspace publication", async () => {
  const registry = await fixture();
  const written = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  barriers.afterWrite = () => {
    written.resolve();
    return release.promise;
  };
  const controller = new AbortController();
  const pending = Effect.runPromise(
    registry.landFile(CONVERSATION, "x", new Uint8Array([1]), controller.signal),
  );
  const refused = expect(pending).rejects.toMatchObject({
    _tag: "DesktopError",
    reason: "failed",
    message: "Could not save that file.",
  });
  await written.promise;
  controller.abort();
  release.resolve();
  await refused;
  expect(barriers.links).toBe(0);
  expect(await readdir(registry.path(CONVERSATION))).toEqual([]);
});

it("rechecks cancellation before retrying a colliding publication name", async () => {
  const registry = await fixture();
  await writeFile(join(registry.path(CONVERSATION), "x"), "existing");
  const controller = new AbortController();
  // The first submitted link can fail with EEXIST after cancellation.
  barriers.beforeLink = () => controller.abort();
  await expect(
    Effect.runPromise(registry.landFile(CONVERSATION, "x", new Uint8Array([1]), controller.signal)),
  ).rejects.toMatchObject({
    _tag: "DesktopError",
    reason: "failed",
    message: "Could not save that file.",
  });
  expect(barriers.links).toBe(1);
  expect(await readdir(registry.path(CONVERSATION))).toEqual(["x"]);
});

it("keeps ordinary callers without a signal working", async () => {
  const registry = await fixture();
  expect(
    await Effect.runPromise(registry.landFile(CONVERSATION, "x", new Uint8Array([1]))),
  ).toEqual({ name: "x", bytes: 1 });
});
