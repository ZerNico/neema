import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { readQuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import { uuidv7 } from "uuidv7";
import {
  conversationAgents,
  conversationCompactionCheckpoints,
  conversationDrafts,
  documents,
  conversations,
  conversationQueueEntries,
  messageChunks,
  messageCompactionEvents,
  messageGenerationConfig,
  messageKnowledgeVersions,
  messages,
  messageToolCalls,
  messageUiStates,
  schedules,
  scheduleRuns,
  workTurnReservations,
} from "~/db/schema/index.ts";
import { ownedConversationById } from "../owned-conversation.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import {
  ConversationBusy,
  ConversationNotFound,
  InvalidMessage,
  QuestionUnavailable,
} from "../../errors.ts";
import { lockAccount } from "~/modules/auth/server/account-eligibility.ts";
import { readDefaults, readConfig, writeConfig } from "./generation-config.ts";
import { queueOrder, readQueueGate } from "./queue.ts";
import { freshLease, joinChunks } from "./generation-writes.ts";
import {
  turnMessagesOf,
  questionByCall,
  questionForMessage,
  questionContent,
} from "./questions.ts";
import { lockWorkTurn, expireWorkTurns, rejectReservedWorkTurn } from "./work-turns.ts";
import type { RepoContext } from "./context.ts";
import type {
  EditContent,
  GenerationConfig,
  ConversationDefaults,
  WorkTurnReservationRow,
  ConversationRow,
  MessageRow,
  HistorySnapshot,
  ChatRepo,
} from "../repo.ts";
import type { DbTx } from "~/server/db.ts";

const matchesHistory = (actual: HistorySnapshot, expected: HistorySnapshot): boolean =>
  actual.length === expected.length &&
  actual.every((message, index) => {
    const previous = expected[index]!;
    return (
      message.id === previous.id &&
      message.status === previous.status &&
      message.generationId === previous.generationId &&
      JSON.stringify(message.assistantOutput) === JSON.stringify(previous.assistantOutput) &&
      JSON.stringify(message.providerReplay) === JSON.stringify(previous.providerReplay) &&
      message.content === previous.content &&
      JSON.stringify(message.questionResponse) === JSON.stringify(previous.questionResponse) &&
      message.editedAt?.getTime() === previous.editedAt?.getTime() &&
      message.completedAt?.getTime() === previous.completedAt?.getTime()
    );
  });

/**
 * The locks retry, resume and edit open with, in the order every attempt takes
 * them: the account, then the work-turn reservation, then the conversation.
 * Answers the conversation, or null when the message is gone or the chat is not
 * the reader's. A live reservation fails the claim as busy.
 */
const lockAttemptConversation = Effect.fn("ChatRepo.lockAttemptConversation")(function* (
  tx: DbTx,
  input: { userId: string } & ({ conversationId: string } | { messageId: string }),
) {
  yield* lockAccount(tx, input.userId);
  // Resolve the parent without locking a message first. Every path
  // that changes eligibility takes the conversation lock before rows.
  const target =
    "conversationId" in input
      ? { conversationId: input.conversationId }
      : (yield* tx
          .select({ conversationId: messages.conversationId })
          .from(messages)
          .where(eq(messages.id, input.messageId))
          .pipe(Effect.orDie))[0];
  if (!target) return null;
  yield* rejectReservedWorkTurn(tx, target.conversationId);
  const owned = yield* tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(ownedConversationById(target.conversationId, input.userId))
    .for("update")
    .pipe(Effect.orDie);
  return owned.length === 0 ? null : target;
});

const editedContent = Effect.fn("ChatRepo.editedContent")(function* (
  tx: DbTx,
  current: ReadonlyArray<MessageRow>,
  messageId: string,
  input: EditContent & { attachmentIds: ReadonlyArray<string> },
) {
  const target = current.find((message) => message.id === messageId);
  if (target?.role !== "user" || target.status !== "complete")
    return yield* new InvalidMessage({ reason: "Only completed user messages can be edited." });
  // An answer stays one while the call it names can still be answered.
  const answered = readQuestionResponse(target.questionResponse);
  const batch = answered ? yield* questionByCall(tx, answered.callId) : null;
  if (input.questionResponse) {
    if (!batch || input.attachmentIds.length > 0)
      return yield* new InvalidMessage({
        reason: "These answers can no longer be edited as a question response.",
      });
    return yield* questionContent(batch, input.questionResponse);
  }
  if (batch)
    return yield* new InvalidMessage({
      reason: "Use Edit answers to change a structured question response.",
    });
  return { content: input.content, questionResponse: null };
});

export const attemptClaimMethods = ({ db, attachments }: RepoContext) =>
  ({
    createTurn: Effect.fn("ChatRepo.createTurn")(function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockAccount(tx, input.userId);
            const conversationId = input.conversation.id;
            if (input.scheduleRunId) {
              const [pending] = yield* tx
                .select({ id: scheduleRuns.id, userId: schedules.userId })
                .from(scheduleRuns)
                .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
                .where(
                  and(eq(scheduleRuns.id, input.scheduleRunId), eq(scheduleRuns.status, "pending")),
                )
                .for("update", { of: scheduleRuns })
                .pipe(Effect.orDie);
              if (!pending || pending.userId !== input.userId)
                return yield* new InvalidMessage({
                  reason: "the scheduled fire is no longer pending",
                });
            }
            yield* lockWorkTurn(tx, conversationId);
            yield* expireWorkTurns(tx, conversationId);
            let reservation: WorkTurnReservationRow | null = null;
            if (input.reservationId) {
              const rows = yield* tx
                .select()
                .from(workTurnReservations)
                .where(
                  and(
                    eq(workTurnReservations.id, input.reservationId),
                    eq(workTurnReservations.userId, input.userId),
                  ),
                )
                .for("update")
                .pipe(Effect.orDie);
              reservation = rows[0] ?? null;
              if (!reservation || reservation.conversationId !== conversationId)
                return yield* new ConversationNotFound({ conversationId });
              if (reservation.intent !== input.conversation.kind)
                return yield* new InvalidMessage({ reason: "the reservation intent changed" });
              if (reservation.status === "activated" && reservation.assistantMessageId) {
                const conversationRows = yield* tx
                  .select()
                  .from(conversations)
                  .where(ownedConversationById(conversationId, input.userId))
                  .pipe(Effect.orDie);
                const turnMessages = yield* tx
                  .select()
                  .from(messages)
                  .where(eq(messages.conversationId, conversationId))
                  .orderBy(asc(messages.createdAt), asc(messages.id))
                  .pipe(Effect.orDie);
                const assistantIndex = turnMessages.findIndex(
                  (message) => message.id === reservation!.assistantMessageId,
                );
                const userMessage = turnMessages
                  .slice(0, assistantIndex)
                  .toReversed()
                  .find((message) => message.role === "user");
                const assistant = turnMessages[assistantIndex];
                // Deleted since: a replay finds the chat gone like any send.
                if (!conversationRows[0])
                  return yield* new ConversationNotFound({ conversationId });
                if (!assistant || !userMessage)
                  return yield* Effect.die("Activated Work turn is incomplete");
                return {
                  conversation: conversationRows[0],
                  conversationCreated: reservation.intent === "new",
                  userMessage,
                  assistant,
                  config: yield* readConfig(tx, assistant.id),
                  activatedNow: false,
                };
              }
              if (reservation.status !== "reserved")
                return yield* new ConversationBusy({ conversationId });
            } else {
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
            }

            let conversationCreated = false;
            let conversation: ConversationRow;
            if (input.conversation.kind === "existing") {
              // FOR UPDATE serializes turns per conversation, so two
              // concurrent sends cannot both pass the streaming check.
              const rows = yield* tx
                .select()
                .from(conversations)
                .where(ownedConversationById(conversationId, input.userId))
                .for("update")
                .pipe(Effect.orDie);
              const row = rows[0];
              if (!row) return yield* new ConversationNotFound({ conversationId });
              const streaming = yield* tx
                .select({ id: messages.id })
                .from(messages)
                .where(and(eq(messages.conversationId, row.id), eq(messages.status, "streaming")))
                .pipe(Effect.orDie);
              if (streaming.length > 0)
                return yield* new ConversationBusy({ conversationId: row.id });
              conversation = row;
            } else {
              const existing = yield* tx
                .select({ id: conversations.id })
                .from(conversations)
                .where(eq(conversations.id, conversationId))
                .limit(1)
                .pipe(Effect.orDie);
              if (existing.length > 0)
                return yield* new InvalidMessage({
                  reason: "the proposed conversation id already exists",
                });
              const rows = yield* tx
                .insert(conversations)
                .values({
                  id: conversationId,
                  userId: input.userId,
                  modelId: input.modelId,
                  title: null,
                  mode: input.conversation.mode,
                  temporary: input.conversation.temporary ?? false,
                  projectId: input.conversation.projectId ?? null,
                  ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
                })
                .returning()
                .pipe(Effect.orDie);
              conversation = rows[0]!;
              conversationCreated = true;
            }

            let content = input.content;
            let questionResponse: JsonValue | null = null;
            let continuation: GenerationConfig | undefined;
            if (input.questionResponse) {
              const { callId, response } = input.questionResponse;
              if (input.conversation.kind !== "existing" || input.attachmentIds.length > 0)
                return yield* new QuestionUnavailable({ callId });
              const tail = (yield* tx
                .select()
                .from(messages)
                .where(turnMessagesOf(conversation.id))
                .orderBy(desc(messages.createdAt), desc(messages.id))
                .limit(1)
                .pipe(Effect.orDie))[0];
              const batch = yield* questionForMessage(tx, tail);
              if (!batch || batch.call.id !== callId)
                return yield* new QuestionUnavailable({ callId });
              continuation = yield* readConfig(tx, tail!.id);
              const formatted = yield* questionContent(batch, response);
              content = formatted.content;
              questionResponse = formatted.questionResponse;
            }

            const userRows = yield* tx
              .insert(messages)
              .values({
                id: uuidv7(),
                conversationId: conversation.id,
                role: "user",
                status: "complete",
                content: content!,
                questionResponse,
                originClientId: input.origin?.clientId ?? null,
                originClientName: input.origin?.clientName ?? null,
              })
              .returning()
              .pipe(Effect.orDie);
            const userMessage = userRows[0]!;

            yield* attachments.reconcile(tx, {
              userId: input.userId,
              messageId: userMessage.id,
              attachmentIds: input.attachmentIds,
            });

            if (input.associateAgentId && !conversationCreated)
              return yield* new InvalidMessage({
                reason: "the agent cannot change after chat creation",
              });
            const association = input.associateAgentId ? { agentId: input.associateAgentId } : null;
            const fresh = {
              mode: conversation.mode,
              projectId: conversation.projectId,
              conversationId: conversation.id,
              imageModelId: conversation.imageModelId,
            };
            const defaults: ConversationDefaults = association
              ? { agent: association, ...fresh }
              : conversationCreated
                ? { agent: null, ...fresh }
                : yield* readDefaults(tx, conversation.id);
            const config = yield* input.resolve(tx, defaults, continuation);
            if (input.saveIntegrationChoices)
              yield* input.saveIntegrationChoices(tx, conversation.id);
            if (association)
              yield* tx
                .insert(conversationAgents)
                .values({ conversationId: conversation.id, ...association })
                .pipe(Effect.orDie);

            const assistantRows = yield* tx
              .insert(messages)
              .values({
                id: uuidv7(),
                conversationId: conversation.id,
                role: "assistant",
                status: "streaming",
                generationLeaseUntil: freshLease(),
                modelId: input.modelId,
              })
              .returning()
              .pipe(Effect.orDie);
            yield* writeConfig(tx, assistantRows[0]!.id, config);
            if (input.scheduleRunId)
              yield* tx
                .update(scheduleRuns)
                .set({
                  status: "started",
                  conversationId: conversation.id,
                  messageId: assistantRows[0]!.id,
                  generationId: assistantRows[0]!.generationId,
                })
                .where(
                  and(eq(scheduleRuns.id, input.scheduleRunId), eq(scheduleRuns.status, "pending")),
                )
                .pipe(Effect.orDie);
            yield* tx
              .update(conversations)
              .set({
                modelId: input.modelId,
                lastMessageAt: new Date(),
                updatedAt: new Date(),
                // Writing in an archived chat brings it back; a schedule's
                // fire is nobody writing, so its chat stays put away.
                ...(input.scheduleRunId ? {} : { archivedAt: null }),
              })
              .where(eq(conversations.id, conversation.id))
              .pipe(Effect.orDie);
            if (reservation)
              yield* tx
                .update(workTurnReservations)
                .set({
                  status: "activated",
                  assistantMessageId: assistantRows[0]!.id,
                  updatedAt: sql`now()`,
                })
                .where(eq(workTurnReservations.id, reservation.id))
                .pipe(Effect.orDie);

            return {
              conversation,
              conversationCreated,
              userMessage,
              assistant: assistantRows[0]!,
              config,
              activatedNow: true,
            };
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.catchTag("EffectDrizzleQueryError", Effect.die),
        );
    }),

    promoteNextQueuedTurn: Effect.fn("ChatRepo.promoteNextQueuedTurn")(function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockAccount(tx, input.userId);
            // Before the conversation, in the order reservations take it.
            yield* lockWorkTurn(tx, input.conversationId).pipe(Effect.orDie);
            const [conversation] = yield* tx
              .select()
              .from(conversations)
              .where(
                and(
                  eq(conversations.id, input.conversationId),
                  eq(conversations.userId, input.userId),
                  isNull(conversations.deletedAt),
                ),
              )
              .for("update")
              .pipe(Effect.orDie);
            if (!conversation) return { promoted: false, reason: "empty" } as const;
            const gate = yield* readQueueGate(tx, conversation.id);
            // A person asking may start after a stop, never ahead of an
            // answer still running or a question still open.
            if (gate !== "open" && !(gate === "unsettled" && input.force))
              return { promoted: false, reason: gate } as const;
            const [entry] = yield* tx
              .select()
              .from(conversationQueueEntries)
              .where(
                and(
                  eq(conversationQueueEntries.conversationId, conversation.id),
                  input.jumpQueue
                    ? eq(conversationQueueEntries.id, input.expectedEntryId)
                    : undefined,
                ),
              )
              .orderBy(...queueOrder)
              .limit(1)
              .pipe(Effect.orDie);
            if (!entry)
              return {
                promoted: false,
                reason: input.jumpQueue ? "changed" : "empty",
              } as const;
            if (entry.id !== input.expectedEntryId || entry.revision !== input.expectedRevision)
              return { promoted: false, reason: "changed" } as const;
            if (entry.lastError && !(input.force && input.jumpQueue))
              return { promoted: false, reason: "held" } as const;

            const [userMessage] = yield* tx
              .insert(messages)
              .values({
                id: uuidv7(),
                conversationId: conversation.id,
                role: "user",
                status: "complete",
                content: entry.content,
              })
              .returning()
              .pipe(Effect.orDie);
            // The files change owner in the transaction that creates their
            // message, so no reader ever sees a turn without them.
            yield* attachments.transferQueueEntry(tx, {
              queueEntryId: entry.id,
              messageId: userMessage!.id,
            });
            yield* tx
              .delete(conversationQueueEntries)
              .where(eq(conversationQueueEntries.id, entry.id))
              .pipe(Effect.orDie);
            const config = yield* input.resolve(entry)(
              tx,
              yield* readDefaults(tx, conversation.id),
            );
            const [assistant] = yield* tx
              .insert(messages)
              .values({
                id: uuidv7(),
                conversationId: conversation.id,
                role: "assistant",
                status: "streaming",
                generationLeaseUntil: freshLease(),
                modelId: entry.input.modelId,
              })
              .returning()
              .pipe(Effect.orDie);
            yield* writeConfig(tx, assistant!.id, config);
            yield* tx
              .update(conversations)
              .set({
                modelId: entry.input.modelId,
                lastMessageAt: new Date(),
                updatedAt: new Date(),
                archivedAt: null,
              })
              .where(eq(conversations.id, conversation.id))
              .pipe(Effect.orDie);
            return {
              promoted: true,
              entry,
              conversation,
              userMessage: userMessage!,
              assistant: assistant!,
              config,
            } as const;
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));
    }),

    resetMessageForRetry: Effect.fn("ChatRepo.resetMessageForRetry")(function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const lost = { claimed: false, orphanedKeys: [] as ReadonlyArray<string> };
            const target = yield* lockAttemptConversation(tx, {
              userId: input.userId,
              messageId: input.messageId,
            });
            if (!target) return lost;
            const current = yield* tx
              .select()
              .from(messages)
              .where(eq(messages.conversationId, target.conversationId))
              .orderBy(asc(messages.createdAt), asc(messages.id))
              .pipe(Effect.orDie);
            if (
              current.some((message) => message.status === "streaming") ||
              !matchesHistory(current, input.expectedMessages)
            )
              return lost;
            const index = current.findIndex(
              (message) => message.id === input.messageId && message.role === "assistant",
            );
            if (
              index < 0 ||
              JSON.stringify(current.slice(index + 1).map((message) => message.id)) !==
                JSON.stringify(input.deleteMessageIds)
            )
              return lost;
            if (
              input.edit &&
              !current
                .slice(0, index)
                .some((message) => message.id === input.edit?.messageId && message.role === "user")
            )
              return lost;
            const edited = input.edit
              ? yield* editedContent(tx, current, input.edit.messageId, input.edit)
              : null;
            const previous = yield* readConfig(tx, input.messageId);
            const config = yield* input.resolve(
              tx,
              yield* readDefaults(tx, target.conversationId),
              previous,
            );
            const generationId = uuidv7();
            const claimed = yield* tx
              .update(messages)
              .set({
                status: "streaming",
                generationId,
                generationLeaseUntil: freshLease(),
                assistantOutput: null,
                providerReplay: null,
                opening: null,
                content: "",
                reasoning: "",
                usage: null,
                error: null,
                completedAt: null,
                modelId: input.modelId,
              })
              .where(and(eq(messages.id, input.messageId), ne(messages.status, "streaming")))
              .returning({ id: messages.id })
              .pipe(Effect.orDie);
            if (claimed.length === 0) {
              return { claimed: false, orphanedKeys: [] as ReadonlyArray<string> };
            }

            const orphanedKeys: string[] = [
              ...(yield* attachments.releaseForMessages(tx, [input.messageId])),
            ];
            // A new attempt writes a new answer; its blocks start from their own state.
            yield* tx
              .delete(messageUiStates)
              .where(eq(messageUiStates.messageId, input.messageId))
              .pipe(Effect.orDie);

            if (input.edit) {
              yield* tx
                .update(messages)
                .set({ ...edited!, editedAt: new Date() })
                .where(eq(messages.id, input.edit.messageId))
                .pipe(Effect.orDie);
              orphanedKeys.push(
                ...(yield* attachments.reconcile(tx, {
                  userId: input.userId,
                  messageId: input.edit.messageId,
                  attachmentIds: input.edit.attachmentIds,
                })),
              );
              yield* tx
                .update(conversations)
                .set({ modelId: input.modelId, updatedAt: new Date() })
                .where(eq(conversations.id, input.edit.conversationId))
                .pipe(Effect.orDie);
            }
            // A retry or an edit is writing in the chat, so it unarchives it.
            yield* tx
              .update(conversations)
              .set({ archivedAt: null })
              .where(
                and(
                  eq(conversations.id, target.conversationId),
                  isNotNull(conversations.archivedAt),
                ),
              )
              .pipe(Effect.orDie);

            if (input.invalidateCheckpointThroughMessageIds.length > 0) {
              yield* tx
                .delete(conversationCompactionCheckpoints)
                .where(
                  inArray(conversationCompactionCheckpoints.throughMessageId, [
                    ...input.invalidateCheckpointThroughMessageIds,
                  ]),
                )
                .pipe(Effect.orDie);
            }
            if (input.deleteMessageIds.length > 0) {
              orphanedKeys.push(
                ...(yield* attachments.releaseForMessages(tx, input.deleteMessageIds)),
              );
              yield* tx
                .delete(messages)
                .where(inArray(messages.id, [...input.deleteMessageIds]))
                .pipe(Effect.orDie);
            }
            yield* tx
              .delete(messageChunks)
              .where(eq(messageChunks.messageId, input.messageId))
              .pipe(Effect.orDie);
            yield* tx
              .delete(messageToolCalls)
              .where(eq(messageToolCalls.messageId, input.messageId))
              .pipe(Effect.orDie);
            // This answer is being generated again, so what it produced goes
            // with it. Messages that are deleted outright take their
            // documents and drafts through the foreign key instead; retry
            // keeps the row id, so those have to be removed explicitly.
            yield* tx
              .delete(documents)
              .where(eq(documents.createdByMessageId, input.messageId))
              .pipe(Effect.orDie);
            yield* tx
              .delete(conversationDrafts)
              .where(eq(conversationDrafts.createdByMessageId, input.messageId))
              .pipe(Effect.orDie);
            yield* tx
              .delete(messageCompactionEvents)
              .where(eq(messageCompactionEvents.messageId, input.messageId))
              .pipe(Effect.orDie);
            yield* tx
              .delete(messageKnowledgeVersions)
              .where(eq(messageKnowledgeVersions.messageId, input.messageId))
              .pipe(Effect.orDie);
            yield* tx
              .delete(messageGenerationConfig)
              .where(eq(messageGenerationConfig.messageId, input.messageId))
              .pipe(Effect.orDie);
            yield* writeConfig(tx, input.messageId, config);

            return {
              claimed: true,
              generationId,
              orphanedKeys: orphanedKeys as ReadonlyArray<string>,
            };
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));
    }),

    resumeMessage: Effect.fn("ChatRepo.resumeMessage")(function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const lost = { claimed: false as const };
            const target = yield* lockAttemptConversation(tx, {
              userId: input.userId,
              messageId: input.messageId,
            });
            if (!target) return lost;
            const streaming = yield* tx
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.conversationId, target.conversationId),
                  eq(messages.status, "streaming"),
                ),
              )
              .pipe(Effect.orDie);
            if (streaming.length > 0) return lost;
            // Only the last turn can continue: a later turn would have been
            // answered without whatever the resumed answer goes on to say.
            const [tail] = yield* tx
              .select()
              .from(messages)
              .where(turnMessagesOf(target.conversationId))
              .orderBy(desc(messages.createdAt), desc(messages.id))
              .limit(1)
              .pipe(Effect.orDie);
            if (
              tail?.id !== input.messageId ||
              tail.role !== "assistant" ||
              (tail.status !== "error" && tail.status !== "aborted")
            )
              return lost;
            const config = yield* input.resolve(
              tx,
              yield* readDefaults(tx, target.conversationId),
              yield* readConfig(tx, input.messageId),
            );
            const chunks = yield* tx
              .select({ kind: messageChunks.kind, delta: messageChunks.delta })
              .from(messageChunks)
              .where(eq(messageChunks.messageId, input.messageId))
              .orderBy(asc(messageChunks.seq))
              .pipe(Effect.orDie);
            // A branch copies an answer's text but never its chunks. The
            // client rebuilds a streaming answer from chunks alone, so the
            // copied text becomes the first ones; otherwise the chunks are
            // the text, as the reaper reads them.
            if (chunks.length === 0) {
              const seeded = [
                ...(tail.reasoning ? [{ kind: "reasoning" as const, delta: tail.reasoning }] : []),
                ...(tail.content ? [{ kind: "text" as const, delta: tail.content }] : []),
              ];
              if (seeded.length > 0)
                yield* tx
                  .insert(messageChunks)
                  .values(
                    seeded.map((chunk, index) => ({
                      messageId: input.messageId,
                      seq: index + 1,
                      ...chunk,
                    })),
                  )
                  .pipe(Effect.orDie);
            }
            const joined = (kind: "text" | "reasoning") => joinChunks(chunks, kind);
            const generationId = uuidv7();
            const claimed = yield* tx
              .update(messages)
              .set({
                status: "streaming",
                generationId,
                generationLeaseUntil: freshLease(),
                error: null,
                completedAt: null,
                modelId: input.modelId,
                ...(chunks.length > 0
                  ? { content: joined("text"), reasoning: joined("reasoning") }
                  : {}),
                // Signed image turns belong to the model that wrote them;
                // another model's turns are never merged into them.
                ...(input.modelId === tail.modelId ? {} : { providerReplay: null }),
              })
              .where(
                and(
                  eq(messages.id, input.messageId),
                  inArray(messages.status, ["error", "aborted"]),
                ),
              )
              .returning({ id: messages.id })
              .pipe(Effect.orDie);
            if (claimed.length === 0) return lost;
            // A steer sent to the ended attempt was meant for this answer,
            // so the attempt that continues it takes it in.
            yield* tx
              .update(conversationQueueEntries)
              .set({ steerGenerationId: generationId })
              .where(
                and(
                  eq(conversationQueueEntries.conversationId, target.conversationId),
                  eq(conversationQueueEntries.steerMessageId, input.messageId),
                ),
              )
              .pipe(Effect.orDie);
            yield* tx
              .update(conversations)
              .set({ archivedAt: null })
              .where(
                and(
                  eq(conversations.id, target.conversationId),
                  isNotNull(conversations.archivedAt),
                ),
              )
              .pipe(Effect.orDie);
            yield* tx
              .delete(messageKnowledgeVersions)
              .where(eq(messageKnowledgeVersions.messageId, input.messageId))
              .pipe(Effect.orDie);
            yield* tx
              .delete(messageGenerationConfig)
              .where(eq(messageGenerationConfig.messageId, input.messageId))
              .pipe(Effect.orDie);
            yield* writeConfig(tx, input.messageId, config);
            return {
              claimed: true as const,
              generationId,
            };
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));
    }),

    createAssistantForEdit: Effect.fn("ChatRepo.createAssistantForEdit")(function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const owned = yield* lockAttemptConversation(tx, {
              userId: input.userId,
              conversationId: input.conversationId,
            });
            if (!owned) return null;
            const current = yield* tx
              .select()
              .from(messages)
              .where(eq(messages.conversationId, input.conversationId))
              .orderBy(asc(messages.createdAt), asc(messages.id))
              .pipe(Effect.orDie);
            if (
              current.some((message) => message.status === "streaming") ||
              !matchesHistory(current, input.expectedMessages)
            )
              return null;
            const index = current.findIndex((message) => message.id === input.userMessageId);
            if (
              index < 0 ||
              JSON.stringify(current.slice(index + 1).map((message) => message.id)) !==
                JSON.stringify(input.deleteMessageIds)
            )
              return null;
            const edited = yield* editedContent(tx, current, input.userMessageId, input);
            const config = yield* input.resolve(tx, yield* readDefaults(tx, input.conversationId));
            const claimed = yield* tx
              .update(messages)
              .set({ ...edited, editedAt: new Date() })
              .where(
                and(
                  eq(messages.id, input.userMessageId),
                  eq(messages.conversationId, input.conversationId),
                  eq(messages.role, "user"),
                  eq(messages.status, "complete"),
                  input.expectedEditedAt === null
                    ? isNull(messages.editedAt)
                    : eq(messages.editedAt, input.expectedEditedAt),
                ),
              )
              .returning({ id: messages.id })
              .pipe(Effect.orDie);
            if (claimed.length === 0) return null;

            const orphanedKeys: string[] = [
              ...(yield* attachments.reconcile(tx, {
                userId: input.userId,
                messageId: input.userMessageId,
                attachmentIds: input.attachmentIds,
              })),
            ];

            if (input.invalidateCheckpointThroughMessageIds.length > 0) {
              yield* tx
                .delete(conversationCompactionCheckpoints)
                .where(
                  inArray(conversationCompactionCheckpoints.throughMessageId, [
                    ...input.invalidateCheckpointThroughMessageIds,
                  ]),
                )
                .pipe(Effect.orDie);
            }
            if (input.deleteMessageIds.length > 0) {
              orphanedKeys.push(
                ...(yield* attachments.releaseForMessages(tx, input.deleteMessageIds)),
              );
              yield* tx
                .delete(messages)
                .where(inArray(messages.id, [...input.deleteMessageIds]))
                .pipe(Effect.orDie);
            }
            yield* tx
              .update(conversations)
              .set({ modelId: input.modelId, updatedAt: new Date(), archivedAt: null })
              .where(eq(conversations.id, input.conversationId))
              .pipe(Effect.orDie);

            const created = yield* tx
              .insert(messages)
              .values({
                id: uuidv7(),
                conversationId: input.conversationId,
                role: "assistant",
                status: "streaming",
                generationLeaseUntil: freshLease(),
                modelId: input.modelId,
              })
              .returning()
              .pipe(Effect.orDie);
            yield* writeConfig(tx, created[0]!.id, config);
            return {
              message: created[0]!,
              orphanedKeys: orphanedKeys as ReadonlyArray<string>,
              config,
            };
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));
    }),
  }) satisfies Partial<ChatRepo["Service"]>;
