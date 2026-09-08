import { createHash } from "node:crypto";
import { decodeSkillText, type SkillFile } from "../package.ts";
/** Deterministic local package identity; never trust a remote hash claim. */
export const skillContentHash = (files: readonly SkillFile[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
    )
    .digest("hex");

/** Stored bytes are checked against the row that points at them before use. */
export function decodeStoredFile(
  bytes: Uint8Array,
  file: { path: string; size: number; sha256: string },
): string {
  if (
    bytes.length !== file.size ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw new Error(`Stored skill file failed its integrity check: ${file.path}`);
  return decodeSkillText(bytes, file.path);
}
