import { Context, Effect, Layer } from "effect";
import { ChatService } from "~/modules/chat/server/service.ts";
import type { ScheduleRow } from "./repo.ts";

export interface FireOutcome {
  conversationId: string | null;
  error?: string | undefined;
}

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
      const fire: ScheduleFire["Service"] = (row) =>
        chat
          .runScheduledTurn({
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
          })
          .pipe(
            Effect.map(
              (turn): FireOutcome => ({ conversationId: turn.conversationId }),
            ),
            Effect.catchTags({
              // An unattended fire explains itself on the run row instead of
              // failing the schedule: most causes (model gone, instance without
              // search) may fix themselves before the next fire.
              ModelNotFound: () =>
                Effect.succeed<FireOutcome>({
                  conversationId: null,
                  error: "no available model",
                }),
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
            }),
            // The remaining failures are composer-path errors a scheduled turn
            // never produces (no question, no desktop, no busy composer), but
            // an unattended fire must still end as a run row, not a defect.
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
