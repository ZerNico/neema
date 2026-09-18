import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
// Type-only, so it is erased and cannot evaluate the module before the env var
// below is set: the layer reads BLOB_STORE_ROOT at import time.
import type { BlobStore as BlobStoreService } from "./blob-store.ts";

const root = mkdtempSync(join(tmpdir(), "blob-store-"));
process.env.BLOB_STORE_ROOT = root;

const { BlobStore, blobStorageKey, userBlobPrefix } = await import("./blob-store.ts");
const { fsBlobStoreLayer } = await import("./fs-blob-store.ts");

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const HASH = hash("ab12cd34");
const INCARNATION = "11111111-2222-4333-8444-555555555555";
const keyFor = (userId: string, sha256: string) => blobStorageKey(userId, sha256, INCARNATION);
const bytes = (value: string) => new TextEncoder().encode(value);

const withStore = <A, E>(f: (store: BlobStoreService["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* BlobStore);
    }).pipe(Effect.provide(fsBlobStoreLayer)),
  );

const expectFailure = <A, E>(f: (store: BlobStoreService["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* Effect.flip(f(yield* BlobStore));
    }).pipe(Effect.provide(fsBlobStoreLayer)),
  );

describe("blobStorageKey", () => {
  it("allocates distinct physical incarnations for identical content", () => {
    expect(blobStorageKey("user-1", HASH)).not.toBe(blobStorageKey("user-1", HASH));
  });
  it("shards on the first two hash byte pairs", () => {
    expect(keyFor("user-1", HASH)).toBe(`blobs/user-1/ab/12/${HASH}.${INCARNATION}`);
    expect(userBlobPrefix("user-1")).toBe("blobs/user-1");
  });
});

describe("fsBlobStore", () => {
  it("rejects hash-only keys and user prefixes as object keys", async () => {
    for (const key of [`blobs/alice/ab/12/${HASH}`, userBlobPrefix("alice")]) {
      const error = await expectFailure((store) => store.get(key));
      expect(error).toMatchObject({ _tag: "BlobStoreError", message: "malformed storage key" });
    }
    const error = await expectFailure((store) => store.deletePrefix(keyFor("alice", HASH)));
    expect(error).toMatchObject({ _tag: "BlobStoreError", message: "malformed storage key" });
  });
  it("writes the object at the sharded path and reads it back", async () => {
    const key = keyFor("alice", HASH);
    const stored = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.put(key, bytes("hello"));
        return yield* store.get(key);
      }),
    );
    expect(new TextDecoder().decode(stored)).toBe("hello");
    expect(
      await readFile(join(root, "blobs", "alice", "ab", "12", `${HASH}.${INCARNATION}`), "utf8"),
    ).toBe("hello");
  });

  it("leaves no temp files behind", () => {
    expect(readdirSync(join(root, "blobs", "alice", "ab", "12"))).toEqual([
      `${HASH}.${INCARNATION}`,
    ]);
  });

  it("treats a second put of the same key as a no-op", async () => {
    const key = keyFor("alice", HASH);
    const stored = await withStore((store) =>
      Effect.gen(function* () {
        // Keys are content-addressed, so the bytes on disk are authoritative.
        yield* store.put(key, bytes("different"));
        return yield* store.get(key);
      }),
    );
    expect(new TextDecoder().decode(stored)).toBe("hello");
  });

  it("reports existence and deletes idempotently", async () => {
    const key = keyFor("alice", HASH);
    const result = await withStore((store) =>
      Effect.gen(function* () {
        const before = yield* store.exists(key);
        yield* store.delete(key);
        yield* store.delete(key);
        return { before, after: yield* store.exists(key) };
      }),
    );
    expect(result).toEqual({ before: true, after: false });
  });

  it("deletes a whole user prefix without touching other users", async () => {
    const keep = keyFor("bob", hash("ffeeddcc"));
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.put(keyFor("carol", HASH), bytes("carol"));
        yield* store.put(keep, bytes("bob"));
        yield* store.deletePrefix(userBlobPrefix("carol"));
        return {
          carol: yield* store.exists(keyFor("carol", HASH)),
          bob: yield* store.exists(keep),
        };
      }),
    );
    expect(result).toEqual({ carol: false, bob: true });
  });

  it("rejects keys that are not in the canonical shape", async () => {
    const bad = [
      "blobs/../../etc/passwd",
      `blobs/alice/../../${HASH}`,
      `/abs/blobs/alice/ab/12/${HASH}`,
      `blobs/alice/AB/12/${HASH}`,
      "blobs/alice/ab/12/not-a-hash",
      `../${HASH}`,
    ];
    for (const key of bad) {
      const error = await expectFailure((store) => store.get(key));
      expect(error).toMatchObject({ _tag: "BlobStoreError", message: "malformed storage key" });
    }
  });

  it("never creates anything outside the root", () => {
    expect(readdirSync(root)).toEqual(["blobs"]);
  });

  it("surfaces a read of a missing object as an error", async () => {
    const error = await expectFailure((store) => store.get(keyFor("dave", HASH)));
    expect(error).toMatchObject({ _tag: "BlobStoreError", operation: "get" });
  });

  it("refuses a key whose directory is occupied by a file", async () => {
    // Same first shard as HASH, so `.../ab/12` already exists as a file.
    writeFileSync(join(root, "blobs", "occupied"), "x");
    const error = await expectFailure((store) =>
      store.put(keyFor("occupied", HASH), bytes("nope")),
    );
    expect(error).toMatchObject({ _tag: "BlobStoreError", operation: "put" });
  });
});
