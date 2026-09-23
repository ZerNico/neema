import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { conversationDrafts, conversations } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";
import {
  DraftNotAvailable,
  type ConversationDraft,
  type DraftKind,
} from "../draft-schema.ts";

export type DraftRow = typeof conversationDrafts.$inferSelect;
export type DraftWrite = Partial<
  Pick<DraftRow, "settings" | "revision" | "targetId" | "targetRevision" | "savedDraftRevision">
>;
export const toDraft = (row: DraftRow): ConversationDraft => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Storage for every kind of conversation draft. Kind semantics (what a target
 * is, what a blank draft looks like, which target ids are acceptable) live in
 * the per-kind services; the repo stores and locks rows.
 */
export class DraftRepo extends Context.Service<
  DraftRepo,
  {
    initialize(
      tx: DbTx,
      userId: string,
      conversationId: string,
      createdByMessageId: string,
      kind: DraftKind,
      settings: unknown,
      targetId: string | null,
      targetRevision?: number | null,
    ): Effect.Effect<ConversationDraft, DraftNotAvailable>;
    get(userId: string, draftId: string): Effect.Effect<ConversationDraft | null>;
    /** Oldest first, so a chat's drafts keep the order they were started in. */
    listForConversation(
      userId: string,
      conversationId: string,
      kind: DraftKind,
    ): Effect.Effect<ConversationDraft[]>;
    /** Always conversation → draft; a model fence runs before this acquires either lock. */
    lock(tx: DbTx, userId: string, draftId: string): Effect.Effect<ConversationDraft, DraftNotAvailable>;
    /** Caller holds lock; settings and receipt updates remain in that transaction. */
    write(tx: DbTx, draftId: string, changes: DraftWrite): Effect.Effect<ConversationDraft>;
    remove(tx: DbTx, draftId: string): Effect.Effect<void>;
    /** Taken before reading siblings, so two opens cannot both decide to create. */
    lockConversation(
      tx: DbTx,
      userId: string,
      conversationId: string,
    ): Effect.Effect<void, DraftNotAvailable>;
  }
>()("chat/drafts/DraftRepo") {
  static readonly layer = Layer.effect(
    DraftRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const lockConversation = Effect.fn(function* (
        tx: DbTx,
        userId: string,
        conversationId: string,
      ) {
        const [conversation] = yield* tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
          .for("update")
          .pipe(Effect.orDie);
        if (!conversation) return yield* new DraftNotAvailable({ conversationId });
      });
      return DraftRepo.of({
        lockConversation,
        initialize: Effect.fn("DraftRepo.initialize")(
          function* (
            tx,
            userId,
            conversationId,
            createdByMessageId,
            kind,
            settings,
            targetId,
            targetRevision,
          ) {
            yield* lockConversation(tx, userId, conversationId);
            const [row] = yield* tx
              .insert(conversationDrafts)
              .values({
                id: uuidv7(),
                conversationId,
                createdByMessageId,
                kind,
                settings: settings as DraftRow["settings"],
                targetId,
                targetRevision: targetRevision ?? null,
              })
              .returning()
              .pipe(Effect.orDie);
            return toDraft(row!);
          },
        ),
        get: Effect.fn("DraftRepo.get")(function* (userId, draftId) {
          const [row] = yield* db
            .select({ draft: conversationDrafts })
            .from(conversationDrafts)
            .innerJoin(conversations, eq(conversations.id, conversationDrafts.conversationId))
            .where(and(eq(conversations.userId, userId), eq(conversationDrafts.id, draftId)))
            .pipe(Effect.orDie);
          return row ? toDraft(row.draft) : null;
        }),
        listForConversation: Effect.fn("DraftRepo.listForConversation")(
          function* (userId, conversationId, kind) {
            const rows = yield* db
              .select({ draft: conversationDrafts })
              .from(conversationDrafts)
              .innerJoin(conversations, eq(conversations.id, conversationDrafts.conversationId))
              .where(
                and(
                  eq(conversations.userId, userId),
                  eq(conversationDrafts.conversationId, conversationId),
                  eq(conversationDrafts.kind, kind),
                ),
              )
              .orderBy(asc(conversationDrafts.id))
              .pipe(Effect.orDie);
            return rows.map((row) => toDraft(row.draft));
          },
        ),
        lock: Effect.fn("DraftRepo.lock")(function* (tx, userId, draftId) {
          // Unlocked read only to resolve the parent: the conversation lock is
          // taken first in every path, and the locked re-read below is what the
          // caller acts on.
          const [parent] = yield* tx
            .select({ conversationId: conversationDrafts.conversationId })
            .from(conversationDrafts)
            .where(eq(conversationDrafts.id, draftId))
            .pipe(Effect.orDie);
          if (!parent) return yield* new DraftNotAvailable({ draftId });
          yield* lockConversation(tx, userId, parent.conversationId);
          const [row] = yield* tx
            .select()
            .from(conversationDrafts)
            .where(eq(conversationDrafts.id, draftId))
            .for("update")
            .pipe(Effect.orDie);
          if (!row) return yield* new DraftNotAvailable({ draftId });
          return toDraft(row);
        }),
        write: Effect.fn("DraftRepo.write")(function* (tx, draftId, changes) {
          const [row] = yield* tx
            .update(conversationDrafts)
            .set({ ...changes, updatedAt: new Date() })
            .where(eq(conversationDrafts.id, draftId))
            .returning()
            .pipe(Effect.orDie);
          return toDraft(row!);
        }),
        remove: Effect.fn("DraftRepo.remove")(function* (tx, draftId) {
          yield* tx
            .delete(conversationDrafts)
            .where(eq(conversationDrafts.id, draftId))
            .pipe(Effect.orDie, Effect.asVoid);
        }),
      });
    }),
  );
}
