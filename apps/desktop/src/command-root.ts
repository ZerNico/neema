import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where commands' private folders are made: a folder created with mkdtemp
 * (unique, 0700) in a shared temporary base. The OS sweeps old entries from
 * those bases, so one that vanished or is no longer plainly ours is replaced
 * by a fresh mkdtemp, never recreated by name, which another user could claim.
 */
export interface CommandRoot {
  /** The root to make the next command's folder in. */
  current(): Promise<string>;
  /** Every root this run made, which no path grant may name. */
  all(): readonly string[];
  close(): Promise<void>;
}

const ours = async (path: string) => {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    // Windows reports neither owners nor POSIX modes; its temp folder is the user's own.
    if (process.platform === "win32") return true;
    return info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
};

export const makeCommandRoot = async (base: string): Promise<CommandRoot> => {
  // Recorded by its real path: Windows may spell TEMP in 8.3 short names, which the
  // real paths that grants are judged by never match.
  const fresh = async () => realpath(await mkdtemp(join(base, "neema-commands-")));
  const roots = [await fresh()];
  let current = roots[0] ?? "";
  return {
    current: async () => {
      if (!(await ours(current))) {
        current = await fresh();
        roots.push(current);
      }
      return current;
    },
    all: () => [...roots],
    // A process the kill has not yet reaped may still hold a file (Windows); quitting must not fail.
    // A root replaced by someone else's folder of the same name is theirs now: left alone.
    close: async () => {
      await Promise.all(
        roots.map(async (root) => {
          if (await ours(root))
            await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
        }),
      );
    },
  };
};
