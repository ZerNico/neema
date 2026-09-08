import { createHash } from "node:crypto";
import { Context, Effect, Layer, Semaphore } from "effect";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { BlobStore, blobStorageKey } from "~/modules/attachments/server/blob-store.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import type { SkillSource } from "~/db/schema/skills.ts";
import { SkillConflict, SkillNotAvailable, SkillRejected } from "../errors.ts";
import { validateSkillPackage, type SkillFile } from "../package.ts";
import { decodeStoredFile, skillContentHash } from "./content-hash.ts";
import type { SkillDetail, SkillSummary } from "../schema.ts";
import { SkillRepo, type SaveRevision, type StoredSkillFile } from "./repo.ts";

export type SkillSaveInput = {
  skillId?: string;
  expectedRevision?: number;
  files: readonly SkillFile[];
  source?: SkillSource;
  upstreamBaseline?: readonly SkillFile[];
};

export class SkillService extends Context.Service<
  SkillService,
  {
    list(userId: string): Effect.Effect<SkillSummary[]>;
    get(userId: string, skillId: string): Effect.Effect<SkillSummary, SkillNotAvailable>;
    detail(userId: string, skillId: string): Effect.Effect<SkillDetail, SkillNotAvailable>;
    baseline(userId: string, skillId: string): Effect.Effect<SkillFile[], SkillNotAvailable>;
    save(
      userId: string,
      input: SkillSaveInput,
    ): Effect.Effect<string, SkillRejected | SkillConflict | SkillNotAvailable>;
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
      // Owner access is checked again after the reads, not only before them.
      const readRevision = Effect.fn("SkillService.readRevision")(function* (
        userId: string,
        skillId: string,
        revisionId: string,
      ) {
        const stored = yield* repo.files(userId, { skillId, revisionId });
        const files = yield* Effect.forEach(
          stored,
          (file: StoredSkillFile) =>
            blobs.get(file.storageKey).pipe(
              Effect.orDie,
              Effect.map((bytes) => ({ path: file.path, content: decodeStoredFile(bytes, file) })),
            ),
          { concurrency: 2 },
        );
        yield* repo.ownerRevision(userId, skillId);
        return files;
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
        save: (userId, input) =>
          saves.withPermits(1)(
            Effect.gen(function* () {
              const validated = yield* Effect.try({
                try: () => validateSkillPackage(input.files),
                catch: (error) =>
                  new SkillRejected({
                    reason: error instanceof Error ? error.message : "Invalid skill package.",
                  }),
              });
              if (input.skillId) yield* repo.ownerRevision(userId, input.skillId);
              const baseline = input.upstreamBaseline
                ? yield* Effect.try({
                    try: () => validateSkillPackage(input.upstreamBaseline!),
                    catch: () => new SkillRejected({ reason: "Invalid upstream baseline." }),
                  })
                : null;
              yield* repo.admitSave(userId, {
                ...(input.skillId ? { skillId: input.skillId } : {}),
                ...(input.expectedRevision === undefined
                  ? {}
                  : { expectedRevision: input.expectedRevision }),
                bytes: [...validated.files, ...(baseline?.files ?? [])].reduce(
                  (sum, file) => sum + new TextEncoder().encode(file.content).length,
                  0,
                ),
              });
              const storeFiles = Effect.fn(function* (contents: readonly SkillFile[]) {
                const files: StoredSkillFile[] = [];
                for (const file of contents) {
                  const bytes = new TextEncoder().encode(file.content);
                  const sha256 = createHash("sha256").update(bytes).digest("hex");
                  const storageKey = blobStorageKey(userId, sha256);
                  yield* registry.recordBlobCandidate(storageKey);
                  yield* blobs.put(storageKey, bytes).pipe(Effect.orDie);
                  files.push({ path: file.path, storageKey, sha256, size: bytes.length });
                }
                return files;
              });
              const files = yield* storeFiles(validated.files);
              const baselineFiles = baseline ? yield* storeFiles(baseline.files) : [];
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
                  .filter((file) => !result.unusedKeys.includes(file.storageKey))
                  .map((file) => file.storageKey),
              );
              yield* bus.publishGlobal({ type: "resources.changed" });
              return result.skillId;
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
