import { createHash } from "node:crypto";

/**
 * Logins live in the partition, so each server gets its own: a page from one
 * server must never browse with cookies another server's chats collected.
 */
export const browserProfile = (origin: string) =>
  createHash("sha256").update(origin).digest("hex").slice(0, 16);
