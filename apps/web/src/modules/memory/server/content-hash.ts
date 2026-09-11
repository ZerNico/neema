import { createHash } from "node:crypto";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Canonical form used only for memory deduplication. The displayed content is
 * preserved separately; normalization makes cosmetic Unicode, casing and
 * whitespace differences resolve to the same per-user memory.
 */
export const normalizeMemoryContent = (content: string): string =>
  content
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase()
    .replace(/[.!?]+$/u, "");

export const hashMemoryContent = (content: string): string =>
  sha256(normalizeMemoryContent(content));

/** Exact source text hash: even a cosmetic source edit invalidates provenance. */
export const hashSourceMessageContent = (content: string): string => sha256(content);
