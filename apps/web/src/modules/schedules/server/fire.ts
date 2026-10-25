import { IntegrationNotAvailable } from "~/modules/integrations/errors.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";
import { Context, Effect, Layer, Predicate, Schedule } from "effect";
import { ChatService } from "~/modules/chat/server/service.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { ScheduleRepo, type ScheduleRow } from "./repo.ts";
import { ScheduleSettlement } from "./settle.ts";

/** Started, or why not: skipped for a cause that passes, error for one to fix. */
export type FireOutcome =
  | { conversationId: string }
  | { conversationId: null; status: "error" | "skipped"; reason: string };

/**
 * A chat that is still answering is waited on rather than skipped at once:
 * the owner may be mid-conversation in it. Fifteen seconds apart for up to
 * five minutes, then the run is recorded as skipped.
 */
const BUSY_RETRY = { schedule: Schedule.spaced("15 seconds"), times: 20 } as const;

/** Null names an integration that was deleted, which nothing can name any more. */
const grantUnavailable = (name: string | null) =>
  Effect.fail({ _tag: "GrantUnavailable" as const, name });

/**
 * The one place the scheduler calls into chat. A fire is a plain
 * `runScheduledTurn`; this indirection keeps ScheduleService's layer graph off
 * ChatService (whose own layer sits next to it in the composition root).
 */
export class ScheduleFire extends Context.Service<
  ScheduleFire,
  (row: ScheduleRow, runId: string) => Effect.Effect<FireOutcome>
>()("chat/schedules/ScheduleFire") {
  static readonly layer = Layer.effect(
    ScheduleFire,
    Effect.gen(function* () {
      const chat = yield* ChatService;
      const integrations = yield* IntegrationService;
      const repo = yield* ScheduleRepo;
      const settlement = yield* ScheduleSettlement;
      type Usable = ScheduleRow & { integrationGrants: IntegrationGrant[] };
      const turn = (row: Usable, runId: string, target: { conversationId: string } | null) =>
        chat.runScheduledTurn({
          userId: row.userId,
          scheduleId: row.id,
          scheduleRunId: runId,
          prompt: row.prompt,
          modelId: row.modelId,
          agentId: row.agentId,
          imageModelId: row.imageModelId,
          searchEnabled: row.searchEnabled,
          researchEnabled: row.researchEnabled,
          collectionIds: row.collectionIds,
          skillIds: row.skillIds,
          integrationGrants: row.integrationGrants,
          timeZone: row.timezone,
          target: target ? { kind: "existing", ...target } : { kind: "new" },
          onSettled: settlement.settle,
        });
      // A fresh chat; in "same chat" mode it becomes the chat later fires use,
      // replacing the one this fire found gone (`row.chatId`), if any.
      const fresh = (row: Usable, runId: string) =>
        turn(row, runId, null).pipe(
          Effect.tap((started) =>
            row.chatMode === "same"
              ? repo.adoptChat(row.id, started.conversationId, row.chatId)
              : Effect.void,
          ),
        );
      const start = (row: Usable, runId: string) =>
        row.chatMode === "same" && row.chatId
          ? turn(row, runId, { conversationId: row.chatId }).pipe(
              Effect.retry({
                ...BUSY_RETRY,
                while: (error) => Predicate.isTagged(error, "ConversationBusy"),
              }),
              // Deleted since the claim: start its replacement now rather than
              // skipping this one, and adopt it, whether the chat is purged
              // (the FK cleared chatId) or waiting out its grace. An Undo in
              // between brings the old chat back but leaves the schedule here.
              Effect.catchTag("ConversationNotFound", () => fresh(row, runId)),
            )
          : fresh(row, runId);
      // A granted integration that cannot be used ends the run with a reason,
      // like a lost collection, rather than answering without it unannounced.
      // A lost account is named by its integration, which the reason looks up.
      const grantsUsable = (row: ScheduleRow) =>
        Effect.forEach(row.integrationGrants, ({ connectionId, integrationId, ...grant }) =>
          Effect.gen(function* () {
            if (integrationId === null) return yield* grantUnavailable(null);
            if (connectionId === null) return yield* new IntegrationNotAvailable({ integrationId });
            yield* integrations
              .session(row.userId, connectionId)
              .pipe(Effect.mapError(() => new IntegrationNotAvailable({ integrationId })));
            const usable: IntegrationGrant = { ...grant, integrationId, connectionId };
            return usable;
          }),
        );
      const fire: ScheduleFire["Service"] = (row, runId) =>
        grantsUsable(row)
          .pipe(
            Effect.andThen((integrationGrants) => start({ ...row, integrationGrants }, runId)),
            Effect.catchTag("IntegrationNotAvailable", (error) =>
              integrations
                .directory(row.userId)
                .pipe(
                  Effect.flatMap((directory) =>
                    grantUnavailable(
                      directory.find((entry) => entry.id === error.integrationId)?.name ??
                        error.integrationId,
                    ),
                  ),
                ),
            ),
          )
          .pipe(
            Effect.map((started): FireOutcome => ({ conversationId: started.conversationId })),
            Effect.catchTags({
              // An unattended fire explains itself on the run row instead of
              // failing the schedule: most causes (model gone, instance without
              // search) may fix themselves before the next fire.
              AccountIneligible: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "skipped",
                  reason: "the account is not permitted to run schedules",
                }),
              ModelNotFound: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason: "no available model",
                }),
              ToolUnavailable: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason: "web search is unavailable",
                }),
              InvalidMessage: (error) =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason: error.reason,
                }),
              KnowledgeNotAvailable: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason: "a selected collection is unavailable",
                }),
              KnowledgeRejected: (error) =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason: error.reason,
                }),
              SkillNotAvailable: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason: "a selected skill is unavailable",
                }),
              SkillRejected: (error) =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason: error.reason,
                }),
              // An error, not a skip, so the person hears that it did not run.
              UsageLimitReached: (error) =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason: error.reason,
                }),
              ConversationBusy: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "skipped",
                  reason: "the chat was still answering",
                }),
              GrantUnavailable: (error) =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason:
                    error.name === null
                      ? "an integration this schedule uses was deleted"
                      : `${error.name} is not connected or needs reconnecting`,
                }),
            }),
            // The remaining failures are composer-path errors a scheduled turn
            // never produces (no question, no desktop), but an unattended fire
            // must still end as a run row, not a defect.
            Effect.catch((error) =>
              Effect.logWarning("scheduled turn rejected", { scheduleId: row.id, error }).pipe(
                Effect.as<FireOutcome>({
                  conversationId: null,
                  status: "error",
                  reason: "the scheduled message could not be sent",
                }),
              ),
            ),
          );
      return fire;
    }),
  );
}
