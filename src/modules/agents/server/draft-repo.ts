import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { conversationAgentDrafts, conversations } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";
import { AgentNotAvailable } from "../errors.ts";
import {
  AgentDraftNotAvailable,
  EMPTY_AGENT_DRAFT,
  type AgentDraft,
  type AgentDraftPatch,
  type DraftSettings,
} from "../draft-schema.ts";
import { AgentRepo, type StoredAgent } from "./repo.ts";

type DraftRow = typeof conversationAgentDrafts.$inferSelect;
type DraftWrite = Partial<
  Pick<
    DraftRow,
    "settings" | "revision" | "targetAgentId" | "targetRevision" | "savedDraftRevision"
  >
>;
const toDraft = (row: DraftRow): AgentDraft => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
export const storedAgentToDraftSettings = ({
  row,
  collectionIds,
  skillIds,
}: StoredAgent): DraftSettings => ({
  name: row.name,
  description: row.description,
  icon: row.icon as DraftSettings["icon"],
  instructions: row.instructions,
  modelId: row.modelId,
  searchEnabled: row.searchEnabled,
  planEnabled: row.planEnabled,
  starters: row.starters,
  collectionIds,
  skillIds: skillIds ?? [],
});

export class AgentDraftRepo extends Context.Service<
  AgentDraftRepo,
  {
    initialize(
      tx: DbTx,
      userId: string,
      conversationId: string,
      targetAgentId: string | null,
      changes?: AgentDraftPatch,
    ): Effect.Effect<AgentDraft, AgentDraftNotAvailable | AgentNotAvailable>;
    get(userId: string, draftId: string): Effect.Effect<AgentDraft | null>;
    /** Oldest first, so a chat's drafts keep the order they were started in. */
    listForConversation(userId: string, conversationId: string): Effect.Effect<AgentDraft[]>;
    /** Always conversation → draft; a model fence runs before this acquires either lock. */
    lock(
      tx: DbTx,
      userId: string,
      draftId: string,
    ): Effect.Effect<AgentDraft, AgentDraftNotAvailable>;
    /** Caller holds lock; settings and receipt updates remain in that transaction. */
    write(tx: DbTx, draftId: string, changes: DraftWrite): Effect.Effect<AgentDraft>;
    remove(tx: DbTx, draftId: string): Effect.Effect<void>;
    /** Taken before reading siblings, so two opens cannot both decide to create. */
    lockConversation(
      tx: DbTx,
      userId: string,
      conversationId: string,
    ): Effect.Effect<void, AgentDraftNotAvailable>;
  }
>()("chat/agents/AgentDraftRepo") {
  static readonly layer = Layer.effect(
    AgentDraftRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const agents = yield* AgentRepo;
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
        if (!conversation) return yield* new AgentDraftNotAvailable({ conversationId });
      });
      return AgentDraftRepo.of({
        lockConversation,
        initialize: Effect.fn("AgentDraftRepo.initialize")(
          function* (tx, userId, conversationId, targetAgentId, changes) {
            yield* lockConversation(tx, userId, conversationId);
            const target =
              targetAgentId === null ? null : yield* agents.get(userId, targetAgentId, tx);
            if (targetAgentId !== null && (!target || target.row.userId !== userId))
              return yield* new AgentNotAvailable({ agentId: targetAgentId });
            const [row] = yield* tx
              .insert(conversationAgentDrafts)
              .values({
                id: uuidv7(),
                conversationId,
                settings: {
                  ...(target ? storedAgentToDraftSettings(target) : EMPTY_AGENT_DRAFT),
                  ...changes,
                },
                targetAgentId,
                targetRevision: target?.row.configRevision ?? null,
              })
              .returning()
              .pipe(Effect.orDie);
            return toDraft(row!);
          },
        ),
        get: Effect.fn("AgentDraftRepo.get")(function* (userId, draftId) {
          const [row] = yield* db
            .select({ draft: conversationAgentDrafts })
            .from(conversationAgentDrafts)
            .innerJoin(conversations, eq(conversations.id, conversationAgentDrafts.conversationId))
            .where(and(eq(conversations.userId, userId), eq(conversationAgentDrafts.id, draftId)))
            .pipe(Effect.orDie);
          return row ? toDraft(row.draft) : null;
        }),
        listForConversation: Effect.fn("AgentDraftRepo.listForConversation")(
          function* (userId, conversationId) {
            const rows = yield* db
              .select({ draft: conversationAgentDrafts })
              .from(conversationAgentDrafts)
              .innerJoin(
                conversations,
                eq(conversations.id, conversationAgentDrafts.conversationId),
              )
              .where(
                and(
                  eq(conversations.userId, userId),
                  eq(conversationAgentDrafts.conversationId, conversationId),
                ),
              )
              .orderBy(asc(conversationAgentDrafts.id))
              .pipe(Effect.orDie);
            return rows.map((row) => toDraft(row.draft));
          },
        ),
        lock: Effect.fn("AgentDraftRepo.lock")(function* (tx, userId, draftId) {
          // Unlocked read only to resolve the parent: the conversation lock is
          // taken first in every path, and the locked re-read below is what the
          // caller acts on.
          const [parent] = yield* tx
            .select({ conversationId: conversationAgentDrafts.conversationId })
            .from(conversationAgentDrafts)
            .where(eq(conversationAgentDrafts.id, draftId))
            .pipe(Effect.orDie);
          if (!parent) return yield* new AgentDraftNotAvailable({ draftId });
          yield* lockConversation(tx, userId, parent.conversationId);
          const [row] = yield* tx
            .select()
            .from(conversationAgentDrafts)
            .where(eq(conversationAgentDrafts.id, draftId))
            .for("update")
            .pipe(Effect.orDie);
          if (!row) return yield* new AgentDraftNotAvailable({ draftId });
          return toDraft(row);
        }),
        write: Effect.fn("AgentDraftRepo.write")(function* (tx, draftId, changes) {
          const [row] = yield* tx
            .update(conversationAgentDrafts)
            .set({ ...changes, updatedAt: new Date() })
            .where(eq(conversationAgentDrafts.id, draftId))
            .returning()
            .pipe(Effect.orDie);
          return toDraft(row!);
        }),
        remove: Effect.fn("AgentDraftRepo.remove")(function* (tx, draftId) {
          yield* tx
            .delete(conversationAgentDrafts)
            .where(eq(conversationAgentDrafts.id, draftId))
            .pipe(Effect.orDie, Effect.asVoid);
        }),
      });
    }),
  ).pipe(Layer.provide(AgentRepo.layer));
}
