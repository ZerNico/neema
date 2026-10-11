import { Context, Effect, Layer, Predicate, Schedule } from "effect";
import { ChatService } from "~/modules/chat/server/service.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { ScheduleRepo, type ScheduleRow } from "./repo.ts";
import { ScheduleSettlement } from "./settle.ts";

export interface FireOutcome {
  conversationId: string | null;
  error?: string | undefined;
}

/**
 * A chat that is still answering is waited on rather than skipped at once:
 * the owner may be mid-conversation in it. Fifteen seconds apart for up to
 * five minutes, then the run is recorded as skipped.
 */
const BUSY_RETRY = { schedule: Schedule.spaced("15 seconds"), times: 20 } as const;

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
      const turn = (row: ScheduleRow, runId: string, target: { conversationId: string } | null) =>
        chat.runScheduledTurn({
          userId: row.userId,
          scheduleId: row.id,
          scheduleRunId: runId,
          prompt: row.prompt,
          modelId: row.modelId,
          agentId: row.agentId,
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
      const fresh = (row: ScheduleRow, runId: string) =>
        turn(row, runId, null).pipe(
          Effect.tap((started) =>
            row.chatMode === "same"
              ? repo.adoptChat(row.id, started.conversationId, row.chatId)
              : Effect.void,
          ),
        );
      const start = (row: ScheduleRow, runId: string) =>
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
      const grantsUsable = (row: ScheduleRow) =>
        Effect.forEach(row.integrationGrants, (grant) =>
          integrations.session(row.userId, grant.integrationId).pipe(Effect.asVoid),
        );
      const fire: ScheduleFire["Service"] = (row, runId) =>
        grantsUsable(row)
          .pipe(
            Effect.andThen(() => start(row, runId)),
            Effect.catchTag("IntegrationNotAvailable", (error) =>
              integrations.directory().pipe(
                Effect.flatMap((directory) =>
                  Effect.fail({
                    _tag: "GrantUnavailable" as const,
                    name:
                      directory.find((entry) => entry.id === error.integrationId)?.name ??
                      error.integrationId,
                  }),
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
              ModelNotFound: () =>
                Effect.succeed<FireOutcome>({ conversationId: null, error: "no available model" }),
              ToolUnavailable: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  error: "web search is unavailable",
                }),
              InvalidMessage: (error) =>
                Effect.succeed<FireOutcome>({ conversationId: null, error: error.reason }),
              KnowledgeNotAvailable: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  error: "a selected collection is unavailable",
                }),
              KnowledgeRejected: (error) =>
                Effect.succeed<FireOutcome>({ conversationId: null, error: error.reason }),
              SkillNotAvailable: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  error: "a selected skill is unavailable",
                }),
              SkillRejected: (error) =>
                Effect.succeed<FireOutcome>({ conversationId: null, error: error.reason }),
              ConversationBusy: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  error: "skipped: the chat was still answering",
                }),
              GrantUnavailable: (error) =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  error: `${error.name} is not connected or needs reconnecting`,
                }),
            }),
            // The remaining failures are composer-path errors a scheduled turn
            // never produces (no question, no desktop), but an unattended fire
            // must still end as a run row, not a defect.
            Effect.catch((error) =>
              Effect.logWarning("scheduled turn rejected", { scheduleId: row.id, error }).pipe(
                Effect.as<FireOutcome>({
                  conversationId: null,
                  error: "the scheduled message could not be sent",
                }),
              ),
            ),
          );
      return fire;
    }),
  );
}
