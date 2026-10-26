import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  attachmentBlobs,
  groupMembers,
  groups,
  groupStorageQuotas,
  limitSettings,
  user,
} from "~/db/schema/index.ts";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { Db } from "~/server/db.ts";
import { LimitRejected, StorageFull } from "../errors.ts";
import { effectiveQuota, formatBytes } from "../rules.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";

/** What a person stores and may store; a null quota is none. */
export interface StorageStanding {
  readonly used: number;
  readonly quota: number | null;
}

/** A file as its bytes, or as one already stored that is about to be copied. */
export type StoredFile = Uint8Array | { readonly sha256: string; readonly size: number };

const measured = (file: StoredFile) =>
  file instanceof Uint8Array ? { sha256: sha256Hex(file), size: file.length } : file;

/** The largest quota an admin may set: a petabyte, far past any one person. */
const MAX_QUOTA = 1024 ** 5;

const checkBytes = (bytes: number | null) =>
  bytes === null || (Number.isInteger(bytes) && bytes > 0 && bytes <= MAX_QUOTA)
    ? Effect.void
    : Effect.fail(new LimitRejected({ reason: localized(m.limits_error_quota_range) }));

/**
 * Storage quotas for everyone and for groups, combined like usage limits.
 * Every blob a person owns counts once, however many places use it. Only what
 * people upload is refused; files an answer makes are kept and counted. See
 * `docs/internals/limits.md`.
 */
export class StorageQuota extends Context.Service<
  StorageQuota,
  {
    standing(userId: string): Effect.Effect<StorageStanding>;
    /** Refuses files that would take the person past their quota; bytes they already store are free. */
    admit(userId: string, files: ReadonlyArray<StoredFile>): Effect.Effect<void, StorageFull>;
    /**
     * The same for files kept under another person's ownership, as a project's or a shared
     * document's are. The writer is told whose storage it is, never its numbers.
     */
    admitFor(
      ownerId: string,
      writerId: string,
      files: ReadonlyArray<StoredFile>,
    ): Effect.Effect<void, StorageFull>;
    quotas(): Effect.Effect<{
      everyone: number | null;
      groups: ReadonlyArray<{ groupId: string; bytes: number | null }>;
    }>;
    setEveryone(bytes: number | null): Effect.Effect<void, LimitRejected>;
    /** `undefined` removes the group's own quota, so everyone's holds again. */
    setGroup(groupId: string, bytes: number | null | undefined): Effect.Effect<void, LimitRejected>;
  }
>()("chat/limits/StorageQuota") {
  static readonly layer = Layer.effect(
    StorageQuota,
    Effect.gen(function* () {
      const db = yield* Db;

      const quotaFor = Effect.fn("StorageQuota.quotaFor")(function* (userId: string) {
        const [person] = yield* db
          .select({ role: user.role, everyone: limitSettings.storageBytes })
          .from(user)
          .leftJoin(limitSettings, eq(limitSettings.id, 1))
          .where(eq(user.id, userId))
          .pipe(Effect.orDie);
        if (!person || person.role === "admin") return null;
        const own = yield* db
          .select({ bytes: groupStorageQuotas.bytes })
          .from(groupStorageQuotas)
          .innerJoin(groupMembers, eq(groupMembers.groupId, groupStorageQuotas.groupId))
          .where(eq(groupMembers.userId, userId))
          .pipe(Effect.orDie);
        return effectiveQuota(
          person.everyone ?? null,
          own.map((row) => row.bytes),
        );
      });

      const used = Effect.fn("StorageQuota.used")(function* (userId: string) {
        const [row] = yield* db
          .select({ bytes: sql<number>`coalesce(sum(${attachmentBlobs.size}), 0)::float8` })
          .from(attachmentBlobs)
          .where(eq(attachmentBlobs.userId, userId))
          .pipe(Effect.orDie);
        return Number(row?.bytes ?? 0);
      });

      const admitAs = Effect.fn("StorageQuota.admit")(function* (
        userId: string,
        given: ReadonlyArray<StoredFile>,
        charged: "own" | "someone-else",
      ) {
        const quota = yield* quotaFor(userId);
        if (quota === null) return;
        const files = given.map(measured);
        // Bytes already stored are shared, not stored again, so they cost nothing.
        const digests = [...new Set(files.map((file) => file.sha256))];
        const known = new Set(
          digests.length
            ? (yield* db
                .select({ sha256: attachmentBlobs.sha256 })
                .from(attachmentBlobs)
                .where(
                  and(eq(attachmentBlobs.userId, userId), inArray(attachmentBlobs.sha256, digests)),
                )
                .pipe(Effect.orDie)).map((row) => row.sha256)
            : [],
        );
        const seen = new Set<string>();
        let needed = 0;
        for (const file of files) {
          if (known.has(file.sha256) || seen.has(file.sha256)) continue;
          seen.add(file.sha256);
          needed += file.size;
        }
        if (needed === 0) return;
        const stored = yield* used(userId);
        if (stored + needed <= quota) return;
        return yield* new StorageFull({
          reason:
            charged === "own"
              ? (locale, formats = locale) =>
                  m.limits_error_storage_full(
                    {
                      needed: formatBytes(needed, locale, formats),
                      free: formatBytes(Math.max(0, quota - stored), locale, formats),
                    },
                    { locale },
                  )
              : localized(m.limits_error_owner_storage_full),
        });
      });

      return StorageQuota.of({
        standing: Effect.fn("StorageQuota.standing")(function* (userId: string) {
          return { used: yield* used(userId), quota: yield* quotaFor(userId) };
        }),
        admit: (userId, files) => admitAs(userId, files, "own"),
        admitFor: (ownerId, writerId, files) =>
          admitAs(ownerId, files, ownerId === writerId ? "own" : "someone-else"),
        quotas: Effect.fn("StorageQuota.quotas")(function* () {
          const [settings] = yield* db
            .select({ bytes: limitSettings.storageBytes })
            .from(limitSettings)
            .where(eq(limitSettings.id, 1))
            .pipe(Effect.orDie);
          const rows = yield* db
            .select({ groupId: groupStorageQuotas.groupId, bytes: groupStorageQuotas.bytes })
            .from(groupStorageQuotas)
            .pipe(Effect.orDie);
          return { everyone: settings?.bytes ?? null, groups: rows };
        }),
        setEveryone: Effect.fn("StorageQuota.setEveryone")(function* (bytes) {
          yield* checkBytes(bytes);
          yield* db
            .insert(limitSettings)
            .values({ id: 1, storageBytes: bytes })
            .onConflictDoUpdate({
              target: limitSettings.id,
              set: { storageBytes: bytes, updatedAt: sql`now()` },
            })
            .pipe(Effect.orDie);
        }),
        setGroup: Effect.fn("StorageQuota.setGroup")(function* (groupId, bytes) {
          if (bytes === undefined) {
            yield* db
              .delete(groupStorageQuotas)
              .where(eq(groupStorageQuotas.groupId, groupId))
              .pipe(Effect.orDie);
            return;
          }
          yield* checkBytes(bytes);
          const [group] = yield* db
            .select({ id: groups.id })
            .from(groups)
            .where(eq(groups.id, groupId))
            .pipe(Effect.orDie);
          if (!group)
            return yield* new LimitRejected({ reason: localized(m.limits_error_group_gone) });
          yield* db
            .insert(groupStorageQuotas)
            .values({ groupId, bytes })
            .onConflictDoUpdate({
              target: groupStorageQuotas.groupId,
              set: { bytes, updatedAt: sql`now()` },
            })
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
