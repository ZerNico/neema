import { app, type DownloadItem } from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { LIMITS } from "@chat/desktop-rpc";
import { abortable } from "./calls.ts";

export const DOWNLOAD_MAX = 4;

/**
 * Downloads wait in the app's own data, which no command can open: never the temp folder,
 * which on macOS every command can write. Made synchronously, as Electron wants the save
 * path before the download event returns.
 */
let swept = false;
const staging = () => {
  const directory = join(app.getPath("userData"), "downloads");
  // A crash leaves what was in flight; nothing from an earlier run is still owned.
  if (!swept) rmSync(directory, { recursive: true, force: true });
  swept = true;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
};
const DOWNLOAD_MS = 60_000;

/** Read only the bounded native file, never an untrusted advertised length. */
export async function readDownload(path: string, limit: number, signal: AbortSignal) {
  const file = await open(path, "r");
  try {
    signal.throwIfAborted();
    const info = await file.stat();
    signal.throwIfAborted();
    if (!info.isFile() || info.size === 0 || info.size > limit)
      throw new Error("Invalid download size.");
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      // oxlint-disable-next-line eslint/no-await-in-loop -- bounded reads from one file
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      signal.throwIfAborted();
      if (!bytesRead) throw new Error("Incomplete download.");
      offset += bytesRead;
    }
    const extra = new Uint8Array(1);
    if ((await file.read(extra, 0, 1, offset)).bytesRead)
      throw new Error("Download grew while reading.");
    signal.throwIfAborted();
    return bytes;
  } finally {
    await file.close();
  }
}

/** The item is ours, not a human Save dialog. Every terminal path removes only its own temp file. */
export async function receiveDownload(
  item: Pick<
    DownloadItem,
    "setSavePath" | "getFilename" | "getTotalBytes" | "getReceivedBytes" | "cancel"
  > & {
    on(event: "done", listener: (event: unknown, state: string) => void): unknown;
    on(event: "updated", listener: () => void): unknown;
    removeListener(event: "done", listener: (event: unknown, state: string) => void): unknown;
    removeListener(event: "updated", listener: () => void): unknown;
  },
  land: (name: string, bytes: Uint8Array, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  options: { limit?: number; lifetimeMs?: number; temporary?: string } = {},
) {
  const limit = options.limit ?? LIMITS.importBytes;
  let temporary: string;
  try {
    temporary = options.temporary ?? join(staging(), `neema-download-${randomUUID()}`);
    item.setSavePath(temporary);
  } catch (cause) {
    // Without a save path Electron would ask the person where to save; ours is never theirs.
    item.cancel();
    throw cause;
  }
  const controller = new AbortController();
  const receiving = AbortSignal.any([signal, controller.signal]);
  let terminal = false;
  const { promise: finished, resolve: settle } = Promise.withResolvers<boolean>();
  const done = (_event: unknown, state: string) => {
    terminal = true;
    settle(state === "completed" && !receiving.aborted);
    // Some items report done after cancellation. They must not recreate a retained file.
    if (receiving.aborted) void rm(temporary, { force: true }).catch(() => {});
  };
  const cancel = () => {
    if (!terminal) item.cancel();
    settle(false);
  };
  const progress = () => {
    if (item.getTotalBytes() > limit || item.getReceivedBytes() > limit) controller.abort();
  };
  item.on("done", done);
  item.on("updated", progress);
  receiving.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), options.lifetimeMs ?? DOWNLOAD_MS);
  try {
    if (receiving.aborted) cancel();
    else progress();
    if (!(await finished)) return;
    receiving.throwIfAborted();
    const bytes = await readDownload(temporary, limit, receiving);
    receiving.throwIfAborted();
    await abortable(land(basename(item.getFilename()) || "download", bytes, receiving), receiving);
  } finally {
    clearTimeout(timer);
    receiving.removeEventListener("abort", cancel);
    item.removeListener("updated", progress);
    // Keep the late done cleanup until Electron reports the item terminal.
    if (terminal) item.removeListener("done", done);
    await rm(temporary, { force: true }).catch(() => {});
  }
}
