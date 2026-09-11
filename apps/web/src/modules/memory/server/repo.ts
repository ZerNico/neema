import { and, asc, desc, eq, getTableColumns, ne, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { conversations, memories, memorySettings, messages, tools } from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";
import {
  MAX_MEMORIES_PER_USER,
  type CreateMemoryOutcome,
  type DeleteMemoryOutcome,
  type Memory,
  type MemoryPreferences,
  type SaveModelMemoryOutcome,
  type UpdateMemoryOutcome,
} from "../schema.ts";
import { hashSourceMessageContent } from "./content-hash.ts";
import { MemorySaveGuard, MemorySaveGuardFailure } from "./save-guard.ts";

export type MemoryRow = typeof memories.$inferSelect;
type DbTx = Parameters<Parameters<Db["Service"]["transaction"]>[0]>[0];

const toMemory = (row: MemoryRow): Memory => ({
  id: row.id,
  content: row.content,
  origin: row.origin,
  editedAt: row.editedAt?.toISOString() ?? null,
  sourceConversationId: row.sourceConversationId,
  sourceConversationTitle: null,
  sourceMessageId: row.sourceMessageId,
  sourceMessageEdited: false,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toSettings = (row: typeof memorySettings.$inferSelect): MemoryPreferences => ({
  referenceEnabled: row.referenceEnabled,
  autoSaveEnabled: row.autoSaveEnabled,
  updatedAt: row.updatedAt.toISOString(),
});

// One transaction-scoped lock serializes every operation that can change a
// user's count or content hashes. The database unique index remains the final
// dedupe guard; this lock makes dedupe + the 50-row cap one atomic decision.
const lockUser = (tx: DbTx, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);

const selectByHash = (tx: DbTx, userId: string, contentHash: string, excludeId?: string) =>
  tx
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        eq(memories.contentHash, contentHash),
        ...(excludeId === undefined ? [] : [ne(memories.id, excludeId)]),
      ),
    )
    .limit(1);

const selectSourceMessage = (
  tx: DbTx,
  userId: string,
  sourceConversationId: string,
  sourceMessageId: string,
) =>
  tx
    .select({ content: messages.content })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.id, sourceMessageId),
        eq(messages.conversationId, sourceConversationId),
        eq(messages.role, "user"),
        eq(conversations.userId, userId),
      ),
    )
    // Hold the source stable through hash validation and the memory write. A
    // concurrent content edit takes a conflicting row lock and therefore either
    // commits first (so this read sees the new hash) or waits for this save.
    .for("share")
    .limit(1);

export class MemoryRepo extends Context.Service<
  MemoryRepo,
  {
    getSettings(userId: string): Effect.Effect<MemoryPreferences>;
    updateSettings(
      userId: string,
      input: { referenceEnabled?: boolean; autoSaveEnabled?: boolean },
    ): Effect.Effect<{ preferences: MemoryPreferences; changed: boolean }>;
    list(userId: string): Effect.Effect<ReadonlyArray<Memory>>;
    /** List saved memories for prompt context; source links are provenance only. */
    listReferenceable(userId: string): Effect.Effect<ReadonlyArray<Memory>>;
    createManual(
      userId: string,
      input: { content: string; contentHash: string },
    ): Effect.Effect<CreateMemoryOutcome>;
    updateManual(
      userId: string,
      input: { memoryId: string; content: string; contentHash: string },
    ): Effect.Effect<UpdateMemoryOutcome>;
    delete(userId: string, memoryId: string): Effect.Effect<DeleteMemoryOutcome>;
    clear(userId: string): Effect.Effect<number>;
    saveModel(
      userId: string,
      input: {
        memoryId?: string;
        content: string;
        contentHash: string;
        sourceConversationId: string;
        sourceMessageId: string;
        sourceMessageHash: string;
      },
    ): Effect.Effect<SaveModelMemoryOutcome>;
  }
>()("chat/memory/MemoryRepo") {
  static readonly layer = Layer.effect(
    MemoryRepo,
    Effect.gen(function* () {
      const db = yield* Db;

      const getSettings = Effect.fn("MemoryRepo.getSettings")(function* (userId: string) {
        const select = () =>
          db
            .select()
            .from(memorySettings)
            .where(eq(memorySettings.userId, userId))
            .limit(1)
            .pipe(Effect.orDie);
        const current = yield* select();
        if (current[0]) return toSettings(current[0]);

        const inserted = yield* db
          .insert(memorySettings)
          .values({ userId })
          .onConflictDoNothing()
          .returning()
          .pipe(Effect.orDie);
        // Another initializer may have won while our first read saw no row.
        const row = inserted[0] ?? (yield* select())[0]!;
        return toSettings(row);
      });

      const updateSettings = Effect.fn("MemoryRepo.updateSettings")(function* (
        userId: string,
        input: { referenceEnabled?: boolean; autoSaveEnabled?: boolean },
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* lockUser(tx, userId);
              yield* tx.insert(memorySettings).values({ userId }).onConflictDoNothing();
              const current = (yield* tx
                .select()
                .from(memorySettings)
                .where(eq(memorySettings.userId, userId))
                .limit(1))[0]!;
              const next = {
                referenceEnabled: input.referenceEnabled ?? current.referenceEnabled,
                autoSaveEnabled: input.autoSaveEnabled ?? current.autoSaveEnabled,
              };
              if (
                next.referenceEnabled === current.referenceEnabled &&
                next.autoSaveEnabled === current.autoSaveEnabled
              ) {
                return { preferences: toSettings(current), changed: false } as const;
              }

              const rows = yield* tx
                .update(memorySettings)
                .set({ ...next, updatedAt: new Date() })
                .where(eq(memorySettings.userId, userId))
                .returning();
              return { preferences: toSettings(rows[0]!), changed: true } as const;
            }),
          )
          .pipe(Effect.orDie);
      });

      const list = Effect.fn("MemoryRepo.list")(function* (userId: string) {
        const rows = yield* db
          .select({
            ...getTableColumns(memories),
            sourceConversationTitle: conversations.title,
            currentSourceContent: messages.content,
          })
          .from(memories)
          .leftJoin(
            conversations,
            and(
              eq(conversations.id, memories.sourceConversationId),
              eq(conversations.userId, userId),
            ),
          )
          .leftJoin(messages, eq(messages.id, memories.sourceMessageId))
          .where(eq(memories.userId, userId))
          .orderBy(
            asc(
              sql`case when ${memories.origin} = 'manual' or ${memories.editedAt} is not null then 0 else 1 end`,
            ),
            desc(memories.updatedAt),
            desc(memories.id),
          )
          .pipe(Effect.orDie);

        return rows.map(({ sourceConversationTitle, currentSourceContent, ...row }) => ({
          ...toMemory(row),
          sourceConversationTitle,
          sourceMessageEdited:
            row.sourceMessageHash !== null &&
            currentSourceContent !== null &&
            hashSourceMessageContent(currentSourceContent) !== row.sourceMessageHash,
        }));
      });

      const listReferenceable = Effect.fn("MemoryRepo.listReferenceable")(function* (
        userId: string,
      ) {
        const rows = yield* db
          .select()
          .from(memories)
          .where(eq(memories.userId, userId))
          .orderBy(
            asc(
              sql`case when ${memories.origin} = 'manual' or ${memories.editedAt} is not null then 0 else 1 end`,
            ),
            desc(memories.updatedAt),
            desc(memories.id),
          )
          .pipe(Effect.orDie);

        return rows.map(toMemory);
      });

      const createManual = Effect.fn("MemoryRepo.createManual")(function* (
        userId: string,
        input: { content: string; contentHash: string },
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* lockUser(tx, userId);
              const duplicate = (yield* selectByHash(tx, userId, input.contentHash))[0];
              if (duplicate) {
                if (duplicate.origin === "model" && duplicate.editedAt === null) {
                  const rows = yield* tx
                    .update(memories)
                    .set({
                      origin: "manual",
                      sourceConversationId: null,
                      sourceMessageId: null,
                      sourceMessageHash: null,
                      updatedAt: new Date(),
                    })
                    .where(and(eq(memories.id, duplicate.id), eq(memories.userId, userId)))
                    .returning();
                  return { outcome: "updated", memory: toMemory(rows[0]!) } as const;
                }
                return { outcome: "duplicate", memory: toMemory(duplicate) } as const;
              }

              const countRows = yield* tx
                .select({ value: sql<number>`count(*)::int` })
                .from(memories)
                .where(eq(memories.userId, userId));
              if (countRows[0]!.value >= MAX_MEMORIES_PER_USER) {
                return { outcome: "limit_reached" } as const;
              }

              const rows = yield* tx
                .insert(memories)
                .values({
                  id: uuidv7(),
                  userId,
                  content: input.content,
                  contentHash: input.contentHash,
                  origin: "manual",
                })
                .returning();
              return { outcome: "created", memory: toMemory(rows[0]!) } as const;
            }),
          )
          .pipe(Effect.orDie);
      });

      const updateManual = Effect.fn("MemoryRepo.updateManual")(function* (
        userId: string,
        input: { memoryId: string; content: string; contentHash: string },
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* lockUser(tx, userId);
              const currentRows = yield* tx
                .select()
                .from(memories)
                .where(and(eq(memories.id, input.memoryId), eq(memories.userId, userId)))
                .limit(1);
              if (!currentRows[0]) return { outcome: "not_found" } as const;

              const duplicate = (yield* selectByHash(
                tx,
                userId,
                input.contentHash,
                input.memoryId,
              ))[0];
              if (duplicate) {
                const now = new Date();
                yield* tx
                  .delete(memories)
                  .where(and(eq(memories.id, input.memoryId), eq(memories.userId, userId)));
                const rows = yield* tx
                  .update(memories)
                  .set({
                    content: input.content,
                    contentHash: input.contentHash,
                    editedAt: now,
                    updatedAt: now,
                  })
                  .where(and(eq(memories.id, duplicate.id), eq(memories.userId, userId)))
                  .returning();
                return { outcome: "updated", memory: toMemory(rows[0]!) } as const;
              }

              const now = new Date();
              const rows = yield* tx
                .update(memories)
                .set({
                  content: input.content,
                  contentHash: input.contentHash,
                  editedAt: now,
                  updatedAt: now,
                })
                .where(and(eq(memories.id, input.memoryId), eq(memories.userId, userId)))
                .returning();
              return { outcome: "updated", memory: toMemory(rows[0]!) } as const;
            }),
          )
          .pipe(Effect.orDie);
      });

      const deleteMemory = Effect.fn("MemoryRepo.delete")(function* (
        userId: string,
        memoryId: string,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* lockUser(tx, userId);
              const rows = yield* tx
                .delete(memories)
                .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
                .returning({ id: memories.id });
              return rows.length === 0
                ? ({ outcome: "not_found" } as const)
                : ({ outcome: "deleted" } as const);
            }),
          )
          .pipe(Effect.orDie);
      });

      const clear = Effect.fn("MemoryRepo.clear")(function* (userId: string) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* lockUser(tx, userId);
              const rows = yield* tx
                .delete(memories)
                .where(eq(memories.userId, userId))
                .returning({ id: memories.id });
              return rows.length;
            }),
          )
          .pipe(Effect.orDie);
      });

      const saveModel = Effect.fn("MemoryRepo.saveModel")(function* (
        userId: string,
        input: {
          memoryId?: string;
          content: string;
          contentHash: string;
          sourceConversationId: string;
          sourceMessageId: string;
          sourceMessageHash: string;
        },
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Research and ordinary saves share this transaction, never an outer
              // transaction around it. The conversation fence must precede the
              // user advisory and source locks to serialize correctly with Stop.
              const guard = yield* MemorySaveGuard;
              yield* guard(tx).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.die(new MemorySaveGuardFailure(cause)),
                ),
              );
              yield* lockUser(tx, userId);

              // Hold a shared row lock through the write. Admin updates take an
              // exclusive row lock, so disabling memory either waits for this
              // save to finish or wins first and makes this transaction fail
              // closed. A missing registry row is disabled by definition.
              const globalRows = yield* tx
                .select({ enabled: tools.enabled })
                .from(tools)
                .where(eq(tools.name, "memory"))
                .for("share");
              if (globalRows[0]?.enabled !== true) return { outcome: "disabled" } as const;

              yield* tx.insert(memorySettings).values({ userId }).onConflictDoNothing();
              const settingsRows = yield* tx
                .select({ autoSaveEnabled: memorySettings.autoSaveEnabled })
                .from(memorySettings)
                .where(eq(memorySettings.userId, userId))
                .for("share");
              if (settingsRows[0]?.autoSaveEnabled !== true) {
                return { outcome: "disabled" } as const;
              }

              const source = (yield* selectSourceMessage(
                tx,
                userId,
                input.sourceConversationId,
                input.sourceMessageId,
              ))[0];
              if (!source || hashSourceMessageContent(source.content) !== input.sourceMessageHash) {
                return { outcome: "source_changed" } as const;
              }

              if (input.memoryId !== undefined) {
                const currentRows = yield* tx
                  .select()
                  .from(memories)
                  .where(and(eq(memories.id, input.memoryId), eq(memories.userId, userId)))
                  .limit(1);
                const current = currentRows[0];
                if (!current) return { outcome: "not_found" } as const;
                if (current.origin !== "model" || current.editedAt !== null) {
                  return { outcome: "protected" } as const;
                }
                const duplicate = (yield* selectByHash(
                  tx,
                  userId,
                  input.contentHash,
                  input.memoryId,
                ))[0];
                if (duplicate) {
                  yield* tx
                    .delete(memories)
                    .where(and(eq(memories.id, input.memoryId), eq(memories.userId, userId)));
                  if (duplicate.origin === "model" && duplicate.editedAt === null) {
                    const refreshed = yield* tx
                      .update(memories)
                      .set({
                        sourceConversationId: input.sourceConversationId,
                        sourceMessageId: input.sourceMessageId,
                        sourceMessageHash: input.sourceMessageHash,
                        updatedAt: new Date(),
                      })
                      .where(and(eq(memories.id, duplicate.id), eq(memories.userId, userId)))
                      .returning();
                    return { outcome: "updated", memory: toMemory(refreshed[0]!) } as const;
                  }
                  return { outcome: "updated", memory: toMemory(duplicate) } as const;
                }

                const rows = yield* tx
                  .update(memories)
                  .set({
                    content: input.content,
                    contentHash: input.contentHash,
                    sourceConversationId: input.sourceConversationId,
                    sourceMessageId: input.sourceMessageId,
                    sourceMessageHash: input.sourceMessageHash,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(memories.id, input.memoryId),
                      eq(memories.userId, userId),
                      eq(memories.origin, "model"),
                      sql`${memories.editedAt} is null`,
                    ),
                  )
                  .returning();
                if (!rows[0]) return { outcome: "protected" } as const;
                return { outcome: "updated", memory: toMemory(rows[0]) } as const;
              }

              const duplicate = (yield* selectByHash(tx, userId, input.contentHash))[0];
              if (duplicate) {
                if (
                  duplicate.origin === "model" &&
                  duplicate.editedAt === null &&
                  (duplicate.sourceConversationId !== input.sourceConversationId ||
                    duplicate.sourceMessageId !== input.sourceMessageId ||
                    duplicate.sourceMessageHash !== input.sourceMessageHash)
                ) {
                  const rows = yield* tx
                    .update(memories)
                    .set({
                      sourceConversationId: input.sourceConversationId,
                      sourceMessageId: input.sourceMessageId,
                      sourceMessageHash: input.sourceMessageHash,
                      updatedAt: new Date(),
                    })
                    .where(and(eq(memories.id, duplicate.id), eq(memories.userId, userId)))
                    .returning();
                  return { outcome: "updated", memory: toMemory(rows[0]!) } as const;
                }
                return { outcome: "duplicate", memory: toMemory(duplicate) } as const;
              }
              const countRows = yield* tx
                .select({ value: sql<number>`count(*)::int` })
                .from(memories)
                .where(eq(memories.userId, userId));
              if (countRows[0]!.value >= MAX_MEMORIES_PER_USER) {
                return { outcome: "limit_reached" } as const;
              }

              const rows = yield* tx
                .insert(memories)
                .values({
                  id: uuidv7(),
                  userId,
                  content: input.content,
                  contentHash: input.contentHash,
                  origin: "model",
                  sourceConversationId: input.sourceConversationId,
                  sourceMessageId: input.sourceMessageId,
                  sourceMessageHash: input.sourceMessageHash,
                })
                .returning();
              return { outcome: "created", memory: toMemory(rows[0]!) } as const;
            }),
          )
          .pipe(Effect.orDie);
      });

      return MemoryRepo.of({
        getSettings,
        updateSettings,
        list,
        listReferenceable,
        createManual,
        updateManual,
        delete: deleteMemory,
        clear,
        saveModel,
      });
    }),
  );
}
