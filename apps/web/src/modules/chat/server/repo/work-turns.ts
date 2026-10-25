import { m } from "~/paraglide/messages.js";
import { localized } from "~/i18n/localized.ts";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { conversations, messages, workTurnReservations } from "~/db/schema/index.ts";
import { ownedConversationById } from "../owned-conversation.ts";
import { ConversationBusy, ConversationNotFound, InvalidMessage } from "../../errors.ts";
import type { RepoContext } from "./context.ts";
import type { ChatRepo } from "../repo.ts";
import type { DbTx } from "~/server/db.ts";

export const lockWorkTurn = (tx: DbTx, conversationId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${conversationId}, 94731))`);
/**
 * Settles this conversation's lapsed reservations, under its work-turn lock.
 * Others' wait for their own next attempt: every reader checks expires_at
 * itself, and touching them here would hold their rows under this account's lock.
 */
export const expireWorkTurns = (tx: DbTx, conversationId: string) =>
  tx
    .update(workTurnReservations)
    .set({ status: "expired", updatedAt: sql`now()` })
    .where(
      and(
        eq(workTurnReservations.conversationId, conversationId),
        eq(workTurnReservations.status, "reserved"),
        sql`${workTurnReservations.expiresAt} <= now()`,
      ),
    );
export const rejectReservedWorkTurn = (tx: DbTx, conversationId: string) =>
  Effect.gen(function* () {
    yield* lockWorkTurn(tx, conversationId).pipe(Effect.orDie);
    yield* expireWorkTurns(tx, conversationId).pipe(Effect.orDie);
    const live = yield* tx
      .select({ id: workTurnReservations.id })
      .from(workTurnReservations)
      .where(
        and(
          eq(workTurnReservations.conversationId, conversationId),
          eq(workTurnReservations.status, "reserved"),
        ),
      )
      .limit(1)
      .pipe(Effect.orDie);
    if (live.length > 0) return yield* new ConversationBusy({ conversationId });
  });

export const workTurnMethods = ({ db }: RepoContext) =>
  ({
    reserveWorkTurn: Effect.fn("ChatRepo.reserveWorkTurn")(function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockWorkTurn(tx, input.conversation.id);
            yield* expireWorkTurns(tx, input.conversation.id);
            if (input.conversation.kind === "new") {
              if (input.conversation.mode !== "work")
                return yield* new InvalidMessage({
                  reason: localized(m.chat_error_workspace_files_require_work_chat),
                });
              const existing = yield* tx
                .select({ id: conversations.id })
                .from(conversations)
                .where(eq(conversations.id, input.conversation.id))
                .limit(1)
                .pipe(Effect.orDie);
              if (existing.length > 0)
                return yield* new InvalidMessage({
                  reason: localized(m.chat_error_conversation_id_taken),
                });
            } else {
              const existing = yield* tx
                .select()
                .from(conversations)
                .where(ownedConversationById(input.conversation.id, input.userId))
                .for("update")
                .pipe(Effect.orDie);
              const conversation = existing[0];
              if (!conversation)
                return yield* new ConversationNotFound({
                  conversationId: input.conversation.id,
                });
              if (conversation.mode !== "work")
                return yield* new InvalidMessage({
                  reason: localized(m.chat_error_workspace_files_require_work_chat),
                });
              const streaming = yield* tx
                .select({ id: messages.id })
                .from(messages)
                .where(
                  and(
                    eq(messages.conversationId, conversation.id),
                    eq(messages.status, "streaming"),
                  ),
                )
                .limit(1)
                .pipe(Effect.orDie);
              if (streaming.length > 0)
                return yield* new ConversationBusy({ conversationId: conversation.id });
            }
            const live = yield* tx
              .select({ id: workTurnReservations.id })
              .from(workTurnReservations)
              .where(
                and(
                  eq(workTurnReservations.conversationId, input.conversation.id),
                  eq(workTurnReservations.status, "reserved"),
                ),
              )
              .limit(1)
              .pipe(Effect.orDie);
            if (live.length > 0)
              return yield* new ConversationBusy({ conversationId: input.conversation.id });
            const rows = yield* tx
              .insert(workTurnReservations)
              .values({
                id: input.id,
                userId: input.userId,
                conversationId: input.conversation.id,
                intent: input.conversation.kind,
                expiresAt: sql`now() + interval '2 minutes'`,
              })
              .returning()
              .pipe(Effect.orDie);
            return rows[0]!;
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.catchTag("EffectDrizzleQueryError", Effect.die),
        );
    }),

    getWorkTurnReservation: Effect.fn("ChatRepo.getWorkTurnReservation")(
      function* (userId, reservationId) {
        yield* db
          .update(workTurnReservations)
          .set({ status: "expired", updatedAt: sql`now()` })
          .where(
            and(
              eq(workTurnReservations.id, reservationId),
              eq(workTurnReservations.status, "reserved"),
              sql`${workTurnReservations.expiresAt} <= now()`,
            ),
          )
          .pipe(Effect.orDie);
        const rows = yield* db
          .select()
          .from(workTurnReservations)
          .where(
            and(
              eq(workTurnReservations.id, reservationId),
              eq(workTurnReservations.userId, userId),
            ),
          )
          .limit(1)
          .pipe(Effect.orDie);
        const row = rows[0];
        if (!row) return yield* new ConversationNotFound({ conversationId: reservationId });
        return row;
      },
    ),

    abortWorkTurn: Effect.fn("ChatRepo.abortWorkTurn")(function* (userId, reservationId) {
      const aborted = yield* db
        .update(workTurnReservations)
        .set({ status: "aborted", updatedAt: sql`now()` })
        .where(
          and(
            eq(workTurnReservations.id, reservationId),
            eq(workTurnReservations.userId, userId),
            eq(workTurnReservations.status, "reserved"),
          ),
        )
        .returning()
        .pipe(Effect.orDie);
      if (aborted[0]) return aborted[0];
      // Not reserved any more: activated, expired or already aborted, as it now stands.
      const rows = yield* db
        .select()
        .from(workTurnReservations)
        .where(
          and(eq(workTurnReservations.id, reservationId), eq(workTurnReservations.userId, userId)),
        )
        .limit(1)
        .pipe(Effect.orDie);
      const row = rows[0];
      if (!row) return yield* new ConversationNotFound({ conversationId: reservationId });
      return row;
    }),
  }) satisfies Partial<ChatRepo["Service"]>;
