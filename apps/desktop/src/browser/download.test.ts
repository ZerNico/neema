import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readDownload, receiveDownload } from "./download.ts";

const dirs: string[] = [];
const fixture = async (lifetimeMs = 60_000) => {
  const dir = await mkdtemp(join(tmpdir(), "neema-download-test-"));
  dirs.push(dir);
  let total = 0;
  let received = 0;
  const item = Object.assign(new EventEmitter(), {
    setSavePath: vi.fn(),
    getFilename: () => "x.bin",
    getTotalBytes: () => total,
    getReceivedBytes: () => received,
    cancel: vi.fn(() => item.emit("done", {}, "cancelled")),
  });
  const controller = new AbortController();
  const land = vi.fn(async (_name: string, _bytes: Uint8Array, _signal: AbortSignal) => {});
  const temporary = join(dir, "owned");
  const pending = receiveDownload(item, land, controller.signal, {
    limit: 8,
    lifetimeMs,
    temporary,
  });
  return {
    dir,
    temporary,
    item,
    controller,
    land,
    pending,
    progress: (value: number, declared = 0) => {
      received = value;
      total = declared;
      item.emit("updated", {}, "progressing");
    },
  };
};

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it.each(["declared", "progress"])(
  "cancels native %s overflow and cleans only its exact temp",
  async (kind) => {
    const f = await fixture();
    await writeFile(f.temporary, "tiny");
    const unrelated = join(f.dir, "unrelated");
    await writeFile(unrelated, "keep");
    f.progress(kind === "progress" ? 9 : 0, kind === "declared" ? 9 : 0);
    await f.pending;
    expect(f.item.cancel).toHaveBeenCalledOnce();
    expect(f.land).not.toHaveBeenCalled();
    expect(await readdir(f.dir)).toEqual(["unrelated"]);
    expect(await readFile(unrelated, "utf8")).toBe("keep");
  },
);

it("accepts unknown-total exact-bound files and removes the temp after publication", async () => {
  const f = await fixture();
  await writeFile(f.temporary, new Uint8Array(8));
  f.progress(8);
  f.item.emit("done", {}, "completed");
  await f.pending;
  expect(f.land).toHaveBeenCalledExactlyOnceWith(
    "x.bin",
    new Uint8Array(8),
    expect.any(AbortSignal),
  );
  expect(await readdir(f.dir)).toEqual([]);
});

it("bounds native lifetime and cancel cleanup without a done event", async () => {
  vi.useFakeTimers();
  const f = await fixture(10);
  f.item.cancel.mockImplementation(() => false);
  await writeFile(f.temporary, "tiny");
  await vi.advanceTimersByTimeAsync(10);
  await f.pending;
  expect(f.item.cancel).toHaveBeenCalledOnce();
  expect(f.land).not.toHaveBeenCalled();
  expect(await readdir(f.dir)).toEqual([]);
  // A late terminal report cannot retain a recreated temp.
  await writeFile(f.temporary, "late");
  f.item.emit("done", {}, "completed");
  await vi.waitFor(async () => expect(await readdir(f.dir)).toEqual([]));
});

it("refuses oversized completed native files before bounded reading or landing", async () => {
  const f = await fixture();
  await writeFile(f.temporary, new Uint8Array(9));
  const refused = expect(f.pending).rejects.toThrow("size");
  f.item.emit("done", {}, "completed");
  await refused;
  expect(f.land).not.toHaveBeenCalled();
  expect(await readdir(f.dir)).toEqual([]);
});

it("bounded file reading checks cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neema-download-read-"));
  dirs.push(dir);
  const path = join(dir, "owned");
  await writeFile(path, "tiny");
  const controller = new AbortController();
  controller.abort();
  await expect(readDownload(path, 8, controller.signal)).rejects.toThrow();
});

it("cancels the native item when its staging cannot be set up", async () => {
  const item = Object.assign(new EventEmitter(), {
    setSavePath: vi.fn(() => {
      throw new Error("staging failed");
    }),
    getFilename: () => "x.bin",
    getTotalBytes: () => 0,
    getReceivedBytes: () => 0,
    cancel: vi.fn(),
  });
  await expect(
    receiveDownload(item, async () => {}, new AbortController().signal, {
      temporary: join(tmpdir(), "never"),
    }),
  ).rejects.toThrow("staging failed");
  expect(item.cancel).toHaveBeenCalledOnce();
});
