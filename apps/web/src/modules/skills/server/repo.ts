import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  attachmentBlobs,
  messageSkills,
  skillFiles,
  skillRevisions,
  skills,
  user,
} from "~/db/schema/index.ts";
import type { SkillSource } from "~/db/schema/skills.ts";
import { collectOrphanedBlobs, lockBlobs } from "~/modules/attachments/server/blob-references.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import { BUILTIN_SKILLS } from "../bundled/index.ts";
import { SkillConflict, SkillNotAvailable, SkillRejected } from "../errors.ts";
import { SKILL_LIMITS, type ValidatedSkillPackage } from "../package.ts";
import type { SkillManifestEntry, SkillSummary } from "../schema.ts";
import { skillReadable } from "./access.ts";

type Revision = typeof skillRevisions.$inferSelect;
export interface StoredSkillFile {
  path: string;
  storageKey: string;
  sha256: string;
  size: number;
  /** Null for skill text. */
  mediaType: string | null;
  /** Bytes this user already stores (a kept file or an upload), so none were written. */
  existing?: boolean;
}

/** Retained bytes, each stored file counted once however many revisions share it. */
const QUOTA_BYTES = 250 * 1024 * 1024;
const QUOTA_REASON = "Skill library quota reached (200 skills or 250 MiB of stored files).";

const storedBytes = (
  tx: Pick<DbTx, "select">,
  userId: string,
  incoming: ReadonlyArray<{ sha256: string; size: number }>,
) =>
  Effect.gen(function* () {
    const owned = tx
      .select({ blobId: skillFiles.blobId })
      .from(skillFiles)
      .innerJoin(skillRevisions, eq(skillRevisions.id, skillFiles.revisionId))
      .innerJoin(skills, eq(skills.id, skillRevisions.skillId))
      .where(eq(skills.userId, userId));
    const rows = yield* tx
      .select({ sha256: attachmentBlobs.sha256, size: attachmentBlobs.size })
      .from(attachmentBlobs)
      .where(inArray(attachmentBlobs.id, owned));
    const counted = new Map(rows.map((row) => [row.sha256, row.size]));
    for (const file of incoming) if (!counted.has(file.sha256)) counted.set(file.sha256, file.size);
    return [...counted.values()].reduce((sum, size) => sum + size, 0);
  });
export interface SaveRevision {
  skillId?: string;
  expectedRevision?: number;
  package: ValidatedSkillPackage;
  files: StoredSkillFile[];
  contentHash: string;
  source?: SkillSource | null;
  baselineRevisionId?: string | null;
  upstreamBaseline?: {
    package: ValidatedSkillPackage;
    files: StoredSkillFile[];
    contentHash: string;
  };
}
const summary = (
  row: typeof skills.$inferSelect & { ownerName: string },
  userId: string,
): SkillSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  manualOnly: row.manualOnly,
  audience: row.audience,
  canEdit: row.userId === userId,
  ownerName: row.userId === userId ? null : row.ownerName,
  revision: row.revision,
  updatedAt: row.updatedAt.toISOString(),
});

/** Runs inside the attempt transaction, before any retry/edit reset. */
export const resolveSkillManifest = (
  tx: DbTx,
  userId: string,
  standaloneIds: readonly string[],
  agentIds: readonly string[],
) =>
  Effect.gen(function* () {
    const ids = [...new Set([...standaloneIds, ...agentIds])];
    if (ids.length > SKILL_LIMITS.catalogue || new Set(standaloneIds).size > SKILL_LIMITS.loaded)
      return yield* new SkillRejected({
        reason: "Select at most five explicit skills and twenty total available skills.",
      });
    const result: SkillManifestEntry[] = [];
    // Stable row-lock order across concurrent attempts and editor saves.
    for (const skillId of [...ids].sort()) {
      const [row] = yield* tx
        .select()
        .from(skills)
        .where(and(eq(skills.id, skillId), skillReadable(userId)))
        .for("share");
      if (!row) return yield* new SkillNotAvailable({ skillId });
      const [revision] = yield* tx
        .select()
        .from(skillRevisions)
        .where(and(eq(skillRevisions.skillId, skillId), eq(skillRevisions.revision, row.revision)));
      if (!revision) return yield* new SkillNotAvailable({ skillId });
      result.push({
        skillId,
        revisionId: revision.id,
        name: revision.name,
        description: revision.description,
        manualOnly: revision.manualOnly,
        explicit: standaloneIds.includes(skillId),
        fromAgent: agentIds.includes(skillId),
      });
    }
    return ids.map((id) => result.find((entry) => entry.skillId === id)!);
  });

export class SkillRepo extends Context.Service<
  SkillRepo,
  {
    list(userId: string): Effect.Effect<SkillSummary[]>;
    get(userId: string, skillId: string): Effect.Effect<SkillSummary, SkillNotAvailable>;
    ownerRevision(userId: string, skillId: string): Effect.Effect<Revision, SkillNotAvailable>;
    files(
      userId: string,
      entry: Pick<SkillManifestEntry, "skillId" | "revisionId">,
    ): Effect.Effect<StoredSkillFile[], SkillNotAvailable>;
    authorize(userId: string, skillIds: readonly string[]): Effect.Effect<void, SkillNotAvailable>;
    /** Whether the skill a revision belongs to is still readable by this user. */
    canReadRevision(userId: string, revisionId: string): Effect.Effect<boolean>;
    catalogue(userId: string, exclude: readonly string[]): Effect.Effect<SkillManifestEntry[]>;
    admitSave(
      userId: string,
      input: {
        skillId?: string;
        expectedRevision?: number;
        files: ReadonlyArray<{ sha256: string; size: number }>;
      },
    ): Effect.Effect<void, SkillConflict | SkillNotAvailable | SkillRejected>;
    save(
      userId: string,
      input: SaveRevision,
    ): Effect.Effect<
      { skillId: string; revisionId: string; unusedKeys: string[]; orphanKeys: string[] },
      SkillConflict | SkillNotAvailable | SkillRejected
    >;
    remove(userId: string, skillId: string): Effect.Effect<string[], SkillNotAvailable>;
  }
>()("chat/skills/SkillRepo") {
  static readonly layer = Layer.effect(
    SkillRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const authorize = Effect.fn("SkillRepo.authorize")(function* (
        userId: string,
        ids: readonly string[],
      ) {
        if (!ids.length) return;
        const rows = yield* db
          .select({ id: skills.id })
          .from(skills)
          .where(and(inArray(skills.id, [...ids]), skillReadable(userId)))
          .pipe(Effect.orDie);
        for (const id of ids)
          if (!rows.some((row) => row.id === id))
            return yield* new SkillNotAvailable({ skillId: id });
      });
      const collectUnused = (tx: DbTx, skillId: string) =>
        Effect.gen(function* () {
          const keys: string[] = [];
          // First release superseded local revisions, then their now-unused baselines.
          for (let pass = 0; pass < 2; pass++) {
            const unused = yield* tx
              .select({ id: skillRevisions.id })
              .from(skillRevisions)
              .innerJoin(skills, eq(skills.id, skillRevisions.skillId))
              .where(
                and(
                  eq(skills.id, skillId),
                  sql`not (${skills.deletedAt} is null and ${skillRevisions.revision} = ${skills.revision})`,
                  sql`not exists(select 1 from ${messageSkills} where ${messageSkills.revisionId} = ${skillRevisions.id})`,
                  sql`not exists(select 1 from skill_revisions baseline_owner where baseline_owner.baseline_revision_id = ${skillRevisions.id} and baseline_owner.id <> ${skillRevisions.id})`,
                ),
              );
            if (!unused.length) break;
            const ids = unused.map((row) => row.id);
            const blobs = yield* tx
              .select({ id: skillFiles.blobId })
              .from(skillFiles)
              .where(inArray(skillFiles.revisionId, ids));
            const blobIds = blobs.map((blob) => blob.id);
            yield* lockBlobs(tx, blobIds);
            yield* tx.delete(skillRevisions).where(inArray(skillRevisions.id, ids));
            keys.push(...(yield* collectOrphanedBlobs(tx, blobIds)));
          }
          return keys;
        });
      return SkillRepo.of({
        // What the model may discover on its own: readable, current, and not
        // marked manual-only. Nothing here is a dependency of the attempt.
        catalogue: Effect.fn("SkillRepo.catalogue")(function* (userId, exclude) {
          const [permissions] = yield* db
            .select({
              use: capabilityAllowedSql(userId, "skillsUse"),
              agents: capabilityAllowedSql(userId, "agentsCreate"),
              schedules: capabilityAllowedSql(userId, "schedules"),
            })
            .from(user)
            .where(eq(user.id, userId))
            .pipe(Effect.orDie);
          if (!permissions?.use) return [];
          const rows = yield* db
            .select({ skill: skills, revision: skillRevisions })
            .from(skills)
            .innerJoin(
              skillRevisions,
              and(
                eq(skillRevisions.skillId, skills.id),
                eq(skillRevisions.revision, skills.revision),
              ),
            )
            .where(and(skillReadable(userId), eq(skillRevisions.manualOnly, false)))
            .orderBy(asc(skills.name), asc(skills.id))
            .limit(SKILL_LIMITS.catalogue + exclude.length)
            .pipe(Effect.orDie);
          // Builtins first: they cost the catalogue nothing and the authoring
          // flows should be discoverable even beside a full library.
          return [
            ...BUILTIN_SKILLS.filter(
              (skill) =>
                !exclude.includes(skill.id) &&
                (skill.id === "builtin:agent-authoring"
                  ? permissions.agents
                  : skill.id === "builtin:schedule-authoring"
                    ? permissions.schedules
                    : true),
            ).map((skill) => ({
              skillId: skill.id,
              revisionId: "builtin",
              name: skill.name,
              description: skill.description,
              manualOnly: false,
              explicit: false,
              ambient: true as const,
            })),
            ...rows
              .filter((row) => !exclude.includes(row.skill.id))
              .slice(0, SKILL_LIMITS.catalogue)
              .map((row) => ({
                skillId: row.skill.id,
                revisionId: row.revision.id,
                name: row.revision.name,
                description: row.revision.description,
                manualOnly: false,
                explicit: false,
                ambient: true,
              })),
          ];
        }),
        list: Effect.fn("SkillRepo.list")(function* (userId) {
          const rows = yield* db
            .select({ skill: skills, ownerName: user.name })
            .from(skills)
            .innerJoin(user, eq(user.id, skills.userId))
            .where(skillReadable(userId))
            .orderBy(asc(skills.name), asc(skills.id))
            .pipe(Effect.orDie);
          return rows.map((row) => summary({ ...row.skill, ownerName: row.ownerName }, userId));
        }),
        get: Effect.fn("SkillRepo.get")(function* (userId, skillId) {
          const [row] = yield* db
            .select({ skill: skills, ownerName: user.name })
            .from(skills)
            .innerJoin(user, eq(user.id, skills.userId))
            .where(and(eq(skills.id, skillId), skillReadable(userId)))
            .pipe(Effect.orDie);
          if (!row) return yield* new SkillNotAvailable({ skillId });
          return summary({ ...row.skill, ownerName: row.ownerName }, userId);
        }),
        ownerRevision: Effect.fn("SkillRepo.ownerRevision")(function* (userId, skillId) {
          const [row] = yield* db
            .select({ revision: skillRevisions })
            .from(skillRevisions)
            .innerJoin(
              skills,
              and(
                eq(skills.id, skillRevisions.skillId),
                eq(skills.revision, skillRevisions.revision),
              ),
            )
            .where(
              and(
                eq(skills.id, skillId),
                eq(skills.userId, userId),
                isNull(skills.deletedAt),
                capabilityAllowedSql(userId, "skillsCreate"),
              ),
            )
            .pipe(Effect.orDie);
          if (!row) return yield* new SkillNotAvailable({ skillId });
          return row.revision;
        }),
        authorize,
        canReadRevision: Effect.fn("SkillRepo.canReadRevision")(function* (userId, revisionId) {
          const [row] = yield* db
            .select({ id: skills.id })
            .from(skillRevisions)
            .innerJoin(skills, eq(skills.id, skillRevisions.skillId))
            .where(and(eq(skillRevisions.id, revisionId), skillReadable(userId)))
            .pipe(Effect.orDie);
          return row !== undefined;
        }),
        files: Effect.fn("SkillRepo.files")(function* (userId, entry) {
          yield* authorize(userId, [entry.skillId]);
          const rows = yield* db
            .select({
              path: skillFiles.path,
              storageKey: attachmentBlobs.storageKey,
              sha256: skillFiles.sha256,
              size: skillFiles.byteSize,
              mediaType: skillFiles.mediaType,
            })
            .from(skillFiles)
            .innerJoin(skillRevisions, eq(skillRevisions.id, skillFiles.revisionId))
            .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, skillFiles.blobId))
            .where(
              and(
                eq(skillRevisions.id, entry.revisionId),
                eq(skillRevisions.skillId, entry.skillId),
              ),
            )
            .orderBy(asc(skillFiles.path))
            .pipe(Effect.orDie);
          if (!rows.length) return yield* new SkillNotAvailable({ skillId: entry.skillId });
          return [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        }),
        admitSave: Effect.fn("SkillRepo.admitSave")(function* (userId, input) {
          const [allowed] = yield* db
            .select({ id: user.id })
            .from(user)
            .where(and(eq(user.id, userId), capabilityAllowedSql(userId, "skillsCreate")))
            .pipe(Effect.orDie);
          if (!allowed)
            return yield* new SkillRejected({ reason: "skill creation is unavailable" });
          if (input.skillId) {
            const [current] = yield* db
              .select()
              .from(skills)
              .where(
                and(
                  eq(skills.id, input.skillId),
                  eq(skills.userId, userId),
                  isNull(skills.deletedAt),
                  capabilityAllowedSql(userId, "skillsCreate"),
                ),
              )
              .pipe(Effect.orDie);
            if (!current) return yield* new SkillNotAvailable({ skillId: input.skillId });
            if (current.revision !== input.expectedRevision)
              return yield* new SkillConflict({ skillId: input.skillId });
          }
          const [count] = yield* db
            .select({ total: sql<number>`count(*)::int` })
            .from(skills)
            .where(and(eq(skills.userId, userId), isNull(skills.deletedAt)))
            .pipe(Effect.orDie);
          const bytes = yield* storedBytes(db, userId, input.files).pipe(Effect.orDie);
          if ((!input.skillId && (count?.total ?? 0) >= 200) || bytes > QUOTA_BYTES)
            return yield* new SkillRejected({ reason: QUOTA_REASON });
        }),
        save: Effect.fn("SkillRepo.save")(function* (userId, input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                // Account lock serializes quota checks, including distinct skill saves.
                const [allowed] = yield* tx
                  .select({ id: user.id })
                  .from(user)
                  .where(and(eq(user.id, userId), capabilityAllowedSql(userId, "skillsCreate")))
                  .for("update");
                if (!allowed)
                  return yield* new SkillRejected({ reason: "skill creation is unavailable" });
                const skillId = input.skillId ?? uuidv7();
                let revision = 1;
                let previous: Revision | undefined;
                if (input.skillId) {
                  const [row] = yield* tx
                    .select()
                    .from(skills)
                    .where(
                      and(
                        eq(skills.id, skillId),
                        eq(skills.userId, userId),
                        isNull(skills.deletedAt),
                        capabilityAllowedSql(userId, "skillsCreate"),
                      ),
                    )
                    .for("update");
                  if (!row) return yield* new SkillNotAvailable({ skillId });
                  if (row.revision !== input.expectedRevision)
                    return yield* new SkillConflict({ skillId });
                  revision = row.revision + 1;
                  [previous] = yield* tx
                    .select()
                    .from(skillRevisions)
                    .where(
                      and(
                        eq(skillRevisions.skillId, skillId),
                        eq(skillRevisions.revision, row.revision),
                      ),
                    );
                }
                const [quota] = yield* tx
                  .select({ count: sql<number>`count(*)::int` })
                  .from(skills)
                  .where(and(eq(skills.userId, userId), isNull(skills.deletedAt)));
                const bytes = yield* storedBytes(tx, userId, [
                  ...input.files,
                  ...(input.upstreamBaseline?.files ?? []),
                ]);
                if ((!input.skillId && (quota?.count ?? 0) >= 200) || bytes > QUOTA_BYTES)
                  return yield* new SkillRejected({ reason: QUOTA_REASON });
                const metadata = input.package.metadata;
                if (input.skillId)
                  yield* tx
                    .update(skills)
                    .set({ ...metadata, revision, updatedAt: new Date() })
                    .where(eq(skills.id, skillId));
                else yield* tx.insert(skills).values({ id: skillId, userId, ...metadata });
                const revisionId = uuidv7();
                // Negative ordinals are private upstream baselines, never current/editor revisions.
                // Keeping them in the revision store gives files the same immutable blob lifecycle.
                const baselineId = input.upstreamBaseline ? uuidv7() : undefined;
                if (input.upstreamBaseline && baselineId)
                  yield* tx.insert(skillRevisions).values({
                    id: baselineId,
                    skillId,
                    revision: -revision,
                    ...input.upstreamBaseline.package.metadata,
                    findings: input.upstreamBaseline.package.findings,
                    contentHash: input.upstreamBaseline.contentHash,
                    source: input.source ?? null,
                  });
                yield* tx.insert(skillRevisions).values({
                  id: revisionId,
                  skillId,
                  revision,
                  ...metadata,
                  findings: input.package.findings,
                  contentHash: input.contentHash,
                  source: input.source === undefined ? (previous?.source ?? null) : input.source,
                  baselineRevisionId:
                    baselineId ??
                    (input.baselineRevisionId === undefined
                      ? (previous?.baselineRevisionId ?? (input.source ? revisionId : null))
                      : input.baselineRevisionId),
                });
                const unusedKeys: string[] = [];
                const registrations = [
                  ...input.files.map((file) => ({ file, targetRevisionId: revisionId })),
                  ...(input.upstreamBaseline?.files ?? []).map((file) => ({
                    file,
                    targetRevisionId: baselineId!,
                  })),
                ];
                for (const { file, targetRevisionId } of registrations.sort((a, b) =>
                  a.file.sha256.localeCompare(b.file.sha256),
                )) {
                  // Kept or uploaded bytes must still be stored: never re-register a
                  // key the cleanup may already have removed.
                  const [blob] = file.existing
                    ? yield* tx
                        .select()
                        .from(attachmentBlobs)
                        .where(
                          and(
                            eq(attachmentBlobs.userId, userId),
                            eq(attachmentBlobs.sha256, file.sha256),
                          ),
                        )
                        .for("update")
                    : yield* tx
                        .insert(attachmentBlobs)
                        .values({
                          id: uuidv7(),
                          userId,
                          sha256: file.sha256,
                          storageKey: file.storageKey,
                          size: file.size,
                          mediaType: file.mediaType ?? "text/plain",
                        })
                        .onConflictDoUpdate({
                          target: [attachmentBlobs.userId, attachmentBlobs.sha256],
                          set: { sha256: file.sha256 },
                        })
                        .returning();
                  if (!blob)
                    return yield* new SkillRejected({
                      reason: file.existing
                        ? `${file.path} is no longer stored; upload it again.`
                        : "Could not register skill file.",
                    });
                  if (!file.existing && blob.storageKey !== file.storageKey)
                    unusedKeys.push(file.storageKey);
                  yield* tx.insert(skillFiles).values({
                    revisionId: targetRevisionId,
                    path: file.path,
                    blobId: blob.id,
                    byteSize: file.size,
                    sha256: file.sha256,
                    mediaType: file.mediaType,
                  });
                }
                const orphanKeys = yield* collectUnused(tx, skillId);
                return { skillId, revisionId, unusedKeys, orphanKeys };
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", Effect.die),
              Effect.catchTag("EffectDrizzleQueryError", Effect.die),
            );
        }),
        remove: Effect.fn("SkillRepo.remove")(function* (userId, skillId) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [row] = yield* tx
                  .select()
                  .from(skills)
                  .where(
                    and(
                      eq(skills.id, skillId),
                      eq(skills.userId, userId),
                      isNull(skills.deletedAt),
                    ),
                  )
                  .for("update");
                if (!row) return yield* new SkillNotAvailable({ skillId });
                yield* tx
                  .update(skills)
                  .set({ deletedAt: new Date(), updatedAt: new Date() })
                  .where(eq(skills.id, skillId));
                return yield* collectUnused(tx, skillId);
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", Effect.die),
              Effect.catchTag("EffectDrizzleQueryError", Effect.die),
            );
        }),
      });
    }),
  );
}
