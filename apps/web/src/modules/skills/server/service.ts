import { Context, Duration, Effect, Layer, Schedule, Semaphore } from "effect";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { BlobStore, blobStorageKey } from "~/modules/attachments/server/blob-store.ts";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import type { SkillSource } from "~/db/schema/skills.ts";
import { SkillConflict, SkillNotAvailable, SkillRejected } from "../errors.ts";
import { isBinarySkillFile, validateSkillPackage, type SkillFile } from "../package.ts";
import { decodeStoredFile, skillContentHash, verifyStoredFile } from "./content-hash.ts";
import type { SkillDetail, SkillSaveResult, SkillSummary } from "../schema.ts";
import { SkillRepo, type SaveRevision, type StoredSkillFile } from "./repo.ts";

export type SkillSaveInput = {
  skillId?: string;
  expectedRevision?: number;
  files: readonly SkillFile[];
  source?: SkillSource;
  upstreamBaseline?: readonly SkillFile[];
};

const rejected = (reason: string) => new SkillRejected({ reason });
const validate = (files: readonly SkillFile[], reason?: string) =>
  Effect.try({
    try: () => validateSkillPackage(files),
    catch: (error) =>
      rejected(reason ?? (error instanceof Error ? error.message : "Invalid skill package.")),
  });
/** What a file adds to stored bytes, by the hash that identifies them. */
const measured = (file: SkillFile) => {
  if (isBinarySkillFile(file)) return { sha256: file.binary.sha256!, size: file.binary.size };
  const bytes = new TextEncoder().encode(file.content);
  return { sha256: sha256Hex(bytes), size: bytes.length };
};

export class SkillService extends Context.Service<
  SkillService,
  {
    list(userId: string): Effect.Effect<SkillSummary[]>;
    get(userId: string, skillId: string): Effect.Effect<SkillSummary, SkillNotAvailable>;
    detail(userId: string, skillId: string): Effect.Effect<SkillDetail, SkillNotAvailable>;
    baseline(userId: string, skillId: string): Effect.Effect<SkillFile[], SkillNotAvailable>;
    /**
     * A binary file of the owner's current revision or its upstream baseline, by
     * content hash so a draft that renamed it still finds it: download and export.
     */
    readFile(
      userId: string,
      skillId: string,
      sha256: string,
    ): Effect.Effect<{ bytes: Uint8Array; path: string; mediaType: string }, SkillNotAvailable>;
    save(
      userId: string,
      input: SkillSaveInput,
    ): Effect.Effect<SkillSaveResult, SkillRejected | SkillConflict | SkillNotAvailable>;
    remove(userId: string, skillId: string): Effect.Effect<void, SkillNotAvailable>;
  }
>()("chat/skills/SkillService") {
  static readonly layer = Layer.effect(
    SkillService,
    Effect.gen(function* () {
      const repo = yield* SkillRepo;
      const blobs = yield* BlobStore;
      const registry = yield* AttachmentRepo;
      const attachments = yield* AttachmentService;
      const bus = yield* SyncBus;
      // Bound in-flight candidate bytes as well as committed per-account quotas.
      const saves = yield* Semaphore.make(2);
      yield* repo.sweepUnused().pipe(
        Effect.flatMap((keys) => attachments.deleteBlobs(keys)),
        Effect.catchCause((cause) => Effect.logError("skill revision sweep failed", cause)),
        Effect.repeat(Schedule.spaced(Duration.minutes(5))),
        Effect.forkScoped,
      );
      // Owner access is checked again after the reads, not only before them.
      // Binary files are described, never loaded: their bytes stay out of JSON.
      const readRevision = Effect.fn("SkillService.readRevision")(function* (
        userId: string,
        skillId: string,
        revisionId: string,
      ) {
        const stored = yield* repo.files(userId, { skillId, revisionId });
        const files = yield* Effect.forEach(
          stored,
          (file: StoredSkillFile): Effect.Effect<SkillFile> =>
            file.mediaType === null
              ? blobs.get(file.storageKey).pipe(
                  Effect.orDie,
                  Effect.map((bytes) => ({
                    path: file.path,
                    content: decodeStoredFile(bytes, file),
                  })),
                )
              : Effect.succeed({
                  path: file.path,
                  binary: { size: file.size, mediaType: file.mediaType, sha256: file.sha256 },
                }),
          { concurrency: 2 },
        );
        yield* repo.ownerRevision(userId, skillId);
        return files;
      });
      /** Files a save may keep by hash: the current revision and its upstream baseline. */
      const keepable = Effect.fn("SkillService.keepable")(function* (
        userId: string,
        skillId: string | undefined,
      ) {
        if (!skillId) return [];
        const revision = yield* repo.ownerRevision(userId, skillId);
        return [
          ...(yield* repo.files(userId, { skillId, revisionId: revision.id })),
          ...(revision.baselineRevisionId
            ? yield* repo.files(userId, { skillId, revisionId: revision.baselineRevisionId })
            : []),
        ];
      });
      return SkillService.of({
        list: repo.list,
        get: repo.get,
        detail: Effect.fn("SkillService.detail")(function* (userId, skillId) {
          const revision = yield* repo.ownerRevision(userId, skillId);
          const metadata = yield* repo.get(userId, skillId);
          const contents = yield* readRevision(userId, skillId, revision.id);
          return {
            ...metadata,
            revision: revision.revision,
            files: contents,
            findings: revision.findings,
            source: revision.source,
            revisionId: revision.id,
          };
        }),
        baseline: Effect.fn("SkillService.baseline")(function* (userId, skillId) {
          const revision = yield* repo.ownerRevision(userId, skillId);
          if (!revision.baselineRevisionId) return [];
          return yield* readRevision(userId, skillId, revision.baselineRevisionId);
        }),
        readFile: Effect.fn("SkillService.readFile")(function* (userId, skillId, sha256) {
          const file = (yield* keepable(userId, skillId)).find(
            (candidate) => candidate.mediaType !== null && candidate.sha256 === sha256,
          );
          if (!file?.mediaType) return yield* new SkillNotAvailable({ skillId });
          const bytes = verifyStoredFile(
            yield* blobs.get(file.storageKey).pipe(Effect.orDie),
            file,
          );
          yield* repo.ownerRevision(userId, skillId);
          return { bytes, path: file.path, mediaType: file.mediaType };
        }),
        save: (userId, input) =>
          saves.withPermits(1)(
            Effect.gen(function* () {
              const kept = yield* keepable(userId, input.skillId);
              const uploads: string[] = [];
              // Every binary file is pinned to real stored bytes before anything is
              // validated, so limits and hashes use what is stored, not what was claimed.
              // Keyed by path per file set: validation hands back copies.
              type Pending = Map<string, StoredSkillFile | Uint8Array>;
              const resolve = Effect.fn(function* (files: readonly SkillFile[], pending: Pending) {
                const resolved: SkillFile[] = [];
                for (const file of files) {
                  if (!isBinarySkillFile(file)) {
                    resolved.push({ path: file.path, content: file.content });
                    continue;
                  }
                  if (file.bytes) {
                    const sha256 = sha256Hex(file.bytes);
                    const next = {
                      path: file.path,
                      binary: { size: file.bytes.length, mediaType: file.binary.mediaType, sha256 },
                    };
                    pending.set(file.path, file.bytes);
                    resolved.push(next);
                    continue;
                  }
                  const uploadId = file.binary.uploadId;
                  if (uploadId) {
                    const [row] = yield* registry.listWithBlobsByIds(userId, [uploadId]);
                    if (!row) return yield* rejected(`${file.path}: upload it again.`);
                    uploads.push(uploadId);
                    const next = {
                      path: file.path,
                      binary: { size: row.size, mediaType: row.mediaType, sha256: row.sha256 },
                    };
                    pending.set(file.path, {
                      path: file.path,
                      storageKey: row.storageKey,
                      sha256: row.sha256,
                      size: row.size,
                      mediaType: row.mediaType,
                      existing: true,
                    });
                    resolved.push(next);
                    continue;
                  }
                  const known = kept.find(
                    (candidate) =>
                      candidate.mediaType !== null && candidate.sha256 === file.binary.sha256,
                  );
                  if (!known?.mediaType) return yield* rejected(`${file.path}: upload it again.`);
                  const next = {
                    path: file.path,
                    binary: { size: known.size, mediaType: known.mediaType, sha256: known.sha256 },
                  };
                  pending.set(file.path, { ...known, path: file.path, existing: true });
                  resolved.push(next);
                }
                return resolved;
              });
              const current: Pending = new Map();
              const upstream: Pending = new Map();
              const validated = yield* validate(yield* resolve(input.files, current));
              const baseline = input.upstreamBaseline
                ? yield* validate(
                    yield* resolve(input.upstreamBaseline, upstream),
                    "Invalid upstream baseline.",
                  )
                : null;
              yield* repo.admitSave(userId, {
                ...(input.skillId ? { skillId: input.skillId } : {}),
                ...(input.expectedRevision === undefined
                  ? {}
                  : { expectedRevision: input.expectedRevision }),
                files: [...validated.files, ...(baseline?.files ?? [])].map(measured),
              });
              const storeFiles = Effect.fn(function* (
                contents: readonly SkillFile[],
                pending: Pending,
              ) {
                const files: StoredSkillFile[] = [];
                for (const file of contents) {
                  const known = pending.get(file.path);
                  if (known && !(known instanceof Uint8Array)) {
                    files.push(known);
                    continue;
                  }
                  const bytes =
                    known ?? new TextEncoder().encode(isBinarySkillFile(file) ? "" : file.content);
                  const sha256 = sha256Hex(bytes);
                  const storageKey = blobStorageKey(userId, sha256);
                  yield* registry.recordBlobCandidate(storageKey);
                  yield* blobs.put(storageKey, bytes).pipe(Effect.orDie);
                  files.push({
                    path: file.path,
                    storageKey,
                    sha256,
                    size: bytes.length,
                    mediaType: isBinarySkillFile(file) ? file.binary.mediaType : null,
                  });
                }
                return files;
              });
              const files = yield* storeFiles(validated.files, current);
              const baselineFiles = baseline ? yield* storeFiles(baseline.files, upstream) : [];
              const save: SaveRevision = {
                ...(input.skillId ? { skillId: input.skillId } : {}),
                ...(input.expectedRevision === undefined
                  ? {}
                  : { expectedRevision: input.expectedRevision }),
                package: validated,
                files,
                ...(baseline
                  ? {
                      upstreamBaseline: {
                        package: baseline,
                        files: baselineFiles,
                        contentHash: skillContentHash(baseline.files),
                      },
                    }
                  : {}),
                contentHash: skillContentHash(validated.files),
                ...(input.source ? { source: input.source } : {}),
              };
              const result = yield* repo.save(userId, save);
              yield* attachments.deleteBlobs([...result.unusedKeys, ...result.orphanKeys]);
              yield* registry.clearBlobIntents(
                [...files, ...baselineFiles]
                  .filter((file) => !file.existing && !result.unusedKeys.includes(file.storageKey))
                  .map((file) => file.storageKey),
              );
              // The skill now references the uploaded bytes; the upload's own row is
              // spent. Its bytes stay, since a skill file still points at them.
              for (const uploadId of uploads)
                yield* registry.deleteUnclaimed(userId, uploadId).pipe(
                  Effect.flatMap((keys) => attachments.deleteBlobs([...keys])),
                  Effect.ignore,
                );
              yield* bus.publishGlobal({ type: "resources.changed" });
              return { id: result.skillId, revision: result.revision, files: validated.files };
            }),
          ),
        remove: Effect.fn("SkillService.remove")(function* (userId, skillId) {
          const keys = yield* repo.remove(userId, skillId);
          yield* attachments.deleteBlobs(keys);
          yield* bus.publishGlobal({ type: "resources.changed" });
        }),
      });
    }),
  );
}
