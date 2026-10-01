import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Replaces a JSON file whole, by rename, so a crash mid-write leaves the old
 * file rather than half of the new one. Private to this user, like every
 * grant the shell keeps.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(file)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Runs writes one at a time, in the order asked. Overlapping writes of whole
 * snapshots can finish out of order and bring back what a later one removed.
 * A failed write rejects its caller and does not stop the next.
 */
export function serialWrites() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(write: () => Promise<T>): Promise<T> => {
    const next = tail.then(write, write);
    tail = next.catch(() => {});
    return next;
  };
}
