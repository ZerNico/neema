import { stat } from "node:fs/promises";
import { join } from "node:path";
import { guestRoot, type Mount } from "./paths.ts";

/**
 * The host file behind a guest path in an attached folder, the only place someone besides the
 * model writes. Asked on the host: the guest caches a file's details, so a change saved on the
 * Mac a moment ago may not show there yet.
 */
export const hostFileOf = (path: string, mounts: readonly Mount[]) => {
  for (const mount of mounts) {
    const root = guestRoot(mount);
    if (path.startsWith(`${root}/`)) return join(mount.hostPath, path.slice(root.length + 1));
  }
  return null;
};

/** When and how big the file is now, or null when there is none. */
export const stampOf = (hostFile: string) =>
  stat(hostFile).then(
    (info) => `${info.mtimeMs}:${info.size}`,
    () => null,
  );

/**
 * What the model last saw of each folder file it read or wrote, per chat, so a rewrite of one
 * that changed since (the person saved it in Excel, a sync brought a new copy) is refused instead
 * of silently undoing that change. In memory: after a restart nothing is known, and a write goes
 * through as it would without this.
 */
export class SeenFiles {
  private readonly chats = new Map<string, Map<string, string>>();

  note(chat: string, path: string, stamp: string | null) {
    const files = this.chats.get(chat) ?? new Map<string, string>();
    if (stamp) files.set(path, stamp);
    else files.delete(path);
    this.chats.set(chat, files);
  }

  /** True when the model saw this file and it is different now. */
  changedSince(chat: string, path: string, stamp: string | null) {
    const seen = this.chats.get(chat)?.get(path);
    return seen !== undefined && stamp !== null && stamp !== seen;
  }

  forget(chat: string) {
    this.chats.delete(chat);
  }
}
