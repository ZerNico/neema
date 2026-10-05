import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Config, Duration, Effect, Layer, Schedule } from "effect";
import { BlobStoreError } from "../errors.ts";
import { BlobStore, assertValidBlobKey, isValidBlobKey } from "./blob-store.ts";

const TEMP_AGE_MS = 60 * 60 * 1000;
const TEMP_NAME = /^(.*)\.([0-9a-f]{16})\.tmp$/;
const activeTemps = new Set<string>();

/** Only this writer's abandoned siblings; never follow a symlinked directory. */
export async function sweepStaleBlobTemps(root: string, now = Date.now()): Promise<number> {
  const blobs = join(root, "blobs");
  try {
    if (!(await lstat(blobs)).isDirectory()) return 0;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let removed = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = TEMP_NAME.exec(entry.name);
      if (!match || activeTemps.has(path)) continue;
      const key = relative(root, join(directory, match[1]!)).split(sep).join("/");
      if (!isValidBlobKey(key)) continue;
      const info = await lstat(path).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (!info?.isFile() || now - info.mtimeMs < TEMP_AGE_MS) continue;
      await unlink(path).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
      removed++;
    }
  };
  await visit(blobs);
  return removed;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const attempt = <A>(operation: BlobStoreError["operation"], key: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new BlobStoreError({ operation, key, message: message(error) }),
  });

/**
 * Filesystem BlobStore. The bytes never pass through Postgres; only the
 * metadata does. Buffering a whole file in memory is fine at the 20 MiB cap;
 * the streaming question belongs to the S3 backend, if it ever needs it.
 */
export const fsBlobStoreLayer: Layer.Layer<BlobStore> = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    const configured = yield* Config.String("BLOB_STORE_ROOT").pipe(
      Config.withDefault(".data/storage"),
      Effect.orDie,
    );
    const root = resolve(configured);
    const sweep = Effect.tryPromise(() => sweepStaleBlobTemps(root)).pipe(
      Effect.catchCause((cause) => Effect.logWarning("blob temp cleanup failed", cause)),
    );
    yield* sweep;
    yield* sweep.pipe(
      Effect.delay(Duration.hours(1)),
      Effect.repeat(Schedule.spaced("1 hour")),
      Effect.forkScoped,
    );

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
      activeTemps.add(temp);
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
      }).pipe(Effect.ensuring(Effect.sync(() => activeTemps.delete(temp))));
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
