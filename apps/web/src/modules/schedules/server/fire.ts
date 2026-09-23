import { Context, Effect, Layer, Predicate, Schedule } from "effect";
import { ChatService } from "~/modules/chat/server/service.ts";
import { ScheduleRepo, type ScheduleRow } from "./repo.ts";

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
  (row: ScheduleRow) => Effect.Effect<FireOutcome>
>()("chat/schedules/ScheduleFire") {
  static readonly layer = Layer.effect(
    ScheduleFire,
    Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* ScheduleRepo;
      const turn = (row: ScheduleRow, target: { conversationId: string } | null) =>
        chat.runScheduledTurn({
          userId: row.userId,
          scheduleId: row.id,
          prompt: row.prompt,
          modelId: row.modelId,
          agentId: row.agentId,
          searchEnabled: row.searchEnabled,
          researchEnabled: row.researchEnabled,
          collectionIds: row.collectionIds,
          skillIds: row.skillIds,
          timeZone: row.timezone,
          target: target ? { kind: "existing", ...target } : { kind: "new" },
        });
      // A fresh chat; in "same chat" mode it becomes the chat later fires use.
      const fresh = (row: ScheduleRow) =>
        turn(row, null).pipe(
          Effect.tap((started) =>
            row.chatMode === "same" ? repo.adoptChat(row.id, started.conversationId) : Effect.void,
          ),
        );
      const start = (row: ScheduleRow) =>
        row.chatMode === "same" && row.chatId
          ? turn(row, { conversationId: row.chatId }).pipe(
              Effect.retry({
                ...BUSY_RETRY,
                while: (error) => Predicate.isTagged(error, "ConversationBusy"),
              }),
              // Deleted since the claim (the FK clears chatId for later fires):
              // start its replacement now rather than skipping this one.
              Effect.catchTag("ConversationNotFound", () => fresh(row)),
            )
          : fresh(row);
      const fire: ScheduleFire["Service"] = (row) =>
        start(row).pipe(
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
