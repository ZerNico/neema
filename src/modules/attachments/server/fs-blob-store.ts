import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Config, Effect, Layer } from "effect";
import { BlobStoreError } from "../errors.ts";
import { BlobStore, assertValidBlobKey } from "./blob-store.ts";

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Filesystem BlobStore. The bytes never pass through Postgres; only the
 * metadata does. Buffering a whole file in memory is fine at the 20 MiB cap —
 * the streaming question belongs to the S3 backend, if it ever needs it.
 */
export const fsBlobStoreLayer: Layer.Layer<BlobStore> = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    const configured = yield* Config.string("BLOB_STORE_ROOT").pipe(
      Config.withDefault(".data/storage"),
      Effect.orDie,
    );
    const root = resolve(configured);

    // Second line of defence behind assertValidBlobKey: whatever the key says,
    // the path it resolves to has to stay inside the root.
    const pathFor = (operation: BlobStoreError["operation"], key: string) =>
      Effect.gen(function* () {
        yield* assertValidBlobKey(operation, key);
        const path = resolve(join(root, key));
        if (path !== root && !path.startsWith(root + sep)) {
          return yield* new BlobStoreError({
            operation,
            key,
            message: "storage key escapes the store root",
          });
        }
        return path;
      });

    const attempt = <A>(
      operation: BlobStoreError["operation"],
      key: string,
      run: () => Promise<A>,
    ) =>
      Effect.tryPromise({
        try: run,
        catch: (error) => new BlobStoreError({ operation, key, message: message(error) }),
      });

    const put = Effect.fn("BlobStore.put")(function* (key: string, bytes: Uint8Array) {
      const path = yield* pathFor("put", key);
      // Content-addressed: an existing object has exactly these bytes.
      const present = yield* attempt("put", key, () =>
        stat(path).then(
          () => true,
          (error: unknown) => {
            if (isMissing(error)) return false;
            throw error;
          },
        ),
      );
      if (present) return;

      const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      yield* attempt("put", key, async () => {
        await mkdir(dirname(path), { recursive: true });
        try {
          await writeFile(temp, bytes, { flag: "wx" });
          // Atomic within the directory, so a concurrent put of the same
          // content either wins or is overwritten by identical bytes.
          await rename(temp, path);
        } catch (error) {
          await rm(temp, { force: true });
          throw error;
        }
      });
    });

    const get = Effect.fn("BlobStore.get")(function* (key: string) {
      const path = yield* pathFor("get", key);
      const buffer = yield* attempt("get", key, () => readFile(path));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    });

    const remove = Effect.fn("BlobStore.delete")(function* (key: string) {
      const path = yield* pathFor("delete", key);
      yield* attempt("delete", key, () =>
        unlink(path).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        }),
      );
    });

    const exists = Effect.fn("BlobStore.exists")(function* (key: string) {
      const path = yield* pathFor("exists", key);
      return yield* attempt("exists", key, () =>
        stat(path).then(
          () => true,
          (error: unknown) => {
            if (isMissing(error)) return false;
            throw error;
          },
        ),
      );
    });

    const deletePrefix = Effect.fn("BlobStore.deletePrefix")(function* (prefix: string) {
      const path = yield* pathFor("deletePrefix", prefix);
      yield* attempt("deletePrefix", prefix, () => rm(path, { recursive: true, force: true }));
    });

    return BlobStore.of({ put, get, delete: remove, exists, deletePrefix });
  }),
);
