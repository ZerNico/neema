import { createHash } from "node:crypto";
import { decodeSkillText, isBinarySkillFile, type SkillFile } from "../package.ts";

/**
 * Deterministic local package identity; never trust a remote hash claim. Text
 * entries hash exactly as they always have, so text-only skills keep theirs;
 * a binary one is its path and content hash.
 */
export const skillContentHash = (files: readonly SkillFile[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((file) => {
            if (!isBinarySkillFile(file)) return { path: file.path, content: file.content };
            if (!file.binary.sha256) throw new Error(`Binary skill file unhashed: ${file.path}`);
            return { path: file.path, sha256: file.binary.sha256 };
          }),
      ),
    )
    .digest("hex");

/** Stored bytes are checked against the row that points at them before use. */
export function verifyStoredFile(
  bytes: Uint8Array,
  file: { path: string; size: number; sha256: string },
): Uint8Array {
  if (
    bytes.length !== file.size ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw new Error(`Stored skill file failed its integrity check: ${file.path}`);
  return bytes;
}

export const decodeStoredFile = (
  bytes: Uint8Array,
  file: { path: string; size: number; sha256: string },
): string => decodeSkillText(verifyStoredFile(bytes, file), file.path);
