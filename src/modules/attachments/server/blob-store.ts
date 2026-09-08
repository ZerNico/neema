import { randomUUID } from "node:crypto";
import { Context, Effect } from "effect";
import { BlobStoreError } from "../errors.ts";

/**
 * Object storage for attachment bytes. Keys are opaque strings owned by
 * `blobStorageKey` below; every backend must treat them as flat identifiers
 * (the filesystem one maps the slashes to directories, S3 will not need to).
 *
 * `put` is idempotent for a given incarnation. Database deduplication chooses
 * the shared incarnation; a new upload never reuses a deleted object key.
 */
export class BlobStore extends Context.Service<
  BlobStore,
  {
    put(key: string, bytes: Uint8Array): Effect.Effect<void, BlobStoreError>;
    get(key: string): Effect.Effect<Uint8Array, BlobStoreError>;
    delete(key: string): Effect.Effect<void, BlobStoreError>;
    exists(key: string): Effect.Effect<boolean, BlobStoreError>;
    /**
     * Removes every object under a key prefix. Keys are user-prefixed, so
     * deleting all of one user's files is a single call (filesystem: recursive
     * directory removal; S3 later: list + batch delete).
     */
    deletePrefix(prefix: string): Effect.Effect<void, BlobStoreError>;
  }
>()("chat/attachments/BlobStore") {}

// Two levels of hex sharding keep any single directory small even with a lot
// of blobs per user.
export const blobStorageKey = (
  userId: string,
  sha256: string,
  incarnation: string = randomUUID(),
): string => `blobs/${userId}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${incarnation}`;

export const userBlobPrefix = (userId: string): string => `blobs/${userId}`;

const KEY_PATTERN =
  /^blobs\/[A-Za-z0-9_-]{1,64}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX_PATTERN = /^blobs\/[A-Za-z0-9_-]{1,64}$/;

/**
 * Keys and prefixes only ever come from the helpers above, but they end up as
 * filesystem paths — validating the shape here means a backend never has to
 * reason about `..` or absolute paths.
 */
export const isValidBlobKey = (key: string): boolean => KEY_PATTERN.test(key);

export const assertValidBlobKey = (
  operation: BlobStoreError["operation"],
  key: string,
): Effect.Effect<void, BlobStoreError> =>
  (operation === "deletePrefix" ? PREFIX_PATTERN.test(key) : isValidBlobKey(key))
    ? Effect.void
    : Effect.fail(new BlobStoreError({ operation, key, message: "malformed storage key" }));
