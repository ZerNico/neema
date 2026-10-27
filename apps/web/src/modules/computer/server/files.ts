import { posix } from "node:path";

/** How many of a chat's sent files a call copies and the hint names: the newest. */
const SENT_FILES = 50;

/**
 * Where each file sent in a chat lives on its computer: `/workspace/<name>`, numbered when an
 * earlier file took the name. Decided here from the files' order, so the model's hint and the
 * machine's copy always agree without asking each other.
 */
export const sentFilePaths = (files: ReadonlyArray<{ id: string; name: string }>) => {
  const taken = new Set<string>();
  const placed = files.map((file) => {
    // A name is a name, never a path: no folders, no control characters, never empty.
    const base =
      [...posix.basename(file.name.replaceAll("\\", "/"))]
        .filter((char) => char.charCodeAt(0) >= 0x20)
        .join("") || "file";
    const ext = posix.extname(base);
    const stem = base.slice(0, base.length - ext.length) || base;
    let name = base;
    for (let n = 2; taken.has(name) || name === "." || name === ".."; n += 1)
      name = `${stem} (${n})${ext}`;
    taken.add(name);
    return { id: file.id, path: `/workspace/${name}` };
  });
  return placed.slice(-SENT_FILES);
};
