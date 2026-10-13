import { Context, Effect, Layer, Schema } from "effect";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import {
  DraftNotAvailable,
  DraftRejected,
  type ConversationDraft,
} from "~/modules/drafts/draft-schema.ts";
import { DraftService, type DraftKindConfig } from "~/modules/drafts/server/service.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import {
  EMPTY_SCHEDULE_DRAFT,
  OpenScheduleDraftInput,
  PatchScheduleDraftInput,
  ScheduleDraftRevisionInput,
  ScheduleDraftSettings,
  type OpenScheduleDraftResult,
  type PatchScheduleDraftResult,
  type ReloadScheduleDraftResult,
  type SaveScheduleDraftResult,
  type ScheduleDraft,
} from "../draft-schema.ts";
import { ScheduleNotAvailable } from "../schema.ts";
import { ScheduleRepo, type ScheduleRow } from "./repo.ts";
import { checkScheduleResources, firstFireAt, validateScheduleSettings } from "./validate.ts";

// The generic store keeps settings opaque; every row this service touches is
// kind "schedule", written only from ScheduleDraftSettings, so the cast is the
// decode.
const asSchedule = (draft: ConversationDraft): ScheduleDraft => ({
  ...draft,
  kind: "schedule" as const,
  settings: draft.settings as ScheduleDraftSettings,
});

const scheduleToSettings = (row: ScheduleRow): ScheduleDraftSettings => ({
  name: row.name,
  scheduleText: row.scheduleText,
  cron: row.cron,
  timezone: row.timezone,
  endAt: row.endAt ? row.endAt.toISOString() : null,
  prompt: row.prompt,
  modelId: row.modelId,
  agentId: row.agentId,
  imageModelId: row.imageModelId,
  searchEnabled: row.searchEnabled,
  researchEnabled: row.researchEnabled,
  collectionIds: [...row.collectionIds],
  skillIds: [...row.skillIds],
  chatMode: row.chatMode,
  chatId: row.chatId,
  notify: row.notify,
});

export class ScheduleDraftService extends Context.Service<
  ScheduleDraftService,
  {
    get(userId: string, draftId: string): Effect.Effect<ScheduleDraft | null>;
    list(userId: string, conversationId: string): Effect.Effect<ScheduleDraft[]>;
    open<E = never, R = never>(
      userId: string,
      input: OpenScheduleDraftInput,
      guard: (tx: never) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<
      OpenScheduleDraftResult,
      DraftNotAvailable | DraftRejected | ScheduleNotAvailable | E,
      R
    >;
    patch<E = never, R = never>(
      userId: string,
      input: PatchScheduleDraftInput,
      guard?: (tx: never) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<PatchScheduleDraftResult, DraftNotAvailable | DraftRejected | E, R>;
    save(
      userId: string,
      input: ScheduleDraftRevisionInput,
    ): Effect.Effect<SaveScheduleDraftResult, DraftNotAvailable | DraftRejected>;
    reload(
      userId: string,
      input: ScheduleDraftRevisionInput,
    ): Effect.Effect<ReloadScheduleDraftResult, DraftNotAvailable | DraftRejected>;
    /** Destroys one draft; saved schedules are untouched. */
    discard(
      userId: string,
      draftId: string,
    ): Effect.Effect<void, DraftNotAvailable | DraftRejected>;
  }
>()("chat/schedules/ScheduleDraftService") {
  static readonly layer = Layer.effect(
    ScheduleDraftService,
    Effect.gen(function* () {
      const db = yield* Db;
      const policy = yield* FeaturePolicy;
      const core: DraftService["Service"] = yield* DraftService;
      const repo = yield* ScheduleRepo;
      const providers = yield* ProviderRepo;
      const agents = yield* AgentRepo;
      const bus = yield* SyncBus;
      const revisionInput = Schema.decodeUnknownEffect(ScheduleDraftRevisionInput);

      // A schedule draft's save receipt is the draft revision it last wrote;
      // schedules have no config revision, so targetRevision stays null.
      const config = (userId: string): DraftKindConfig<ScheduleDraftSettings> => ({
        kind: "schedule",
        empty: EMPTY_SCHEDULE_DRAFT,
        // Editing an existing schedule starts from its stored settings, so the
        // model and the user review the live configuration, not a blank form.
        initialSettings: (scheduleId, tx) =>
          repo
            .get(userId, scheduleId, tx)
            .pipe(Effect.map((row) => (row ? scheduleToSettings(row) : EMPTY_SCHEDULE_DRAFT))),
        checkTarget: (scheduleId, tx) =>
          repo.get(userId, scheduleId, tx).pipe(Effect.map((row) => (row ? 1 : null))),
      });

      const changedSchedule = (userId: string, scheduleId: string) =>
        bus
          .publish(userId, { type: "schedule.changed", scheduleId })
          .pipe(Effect.catchCause(() => Effect.logWarning("schedule invalidation failed")));

      return ScheduleDraftService.of({
        get: (userId, draftId) =>
          policy
            .can(userId, "schedules")
            .pipe(
              Effect.flatMap((allowed) =>
                allowed
                  ? core
                      .get(userId, draftId, "schedule")
                      .pipe(Effect.map((draft) => (draft ? asSchedule(draft) : null)))
                  : Effect.succeed(null),
              ),
            ),
        list: (userId, conversationId) =>
          policy
            .can(userId, "schedules")
            .pipe(
              Effect.flatMap((allowed) =>
                allowed
                  ? core
                      .list(userId, conversationId, "schedule")
                      .pipe(Effect.map((rows) => rows.map(asSchedule)))
                  : Effect.succeed([]),
              ),
            ),
        open: (userId, input, guard) =>
          Effect.gen(function* () {
            if (!(yield* policy.can(userId, "schedules")))
              return yield* new ScheduleNotAvailable({ scheduleId: "" });
            const parsed = yield* Schema.decodeUnknownEffect(OpenScheduleDraftInput)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(
                () => new DraftRejected({ reason: "invalid schedule draft request" }),
              ),
            );
            const result = yield* core.open<ScheduleDraftSettings, never, never>(
              userId,
              config(userId),
              {
                conversationId: parsed.conversationId,
                createdByMessageId: parsed.createdByMessageId,
                ...(parsed.scheduleId !== undefined ? { targetId: parsed.scheduleId } : {}),
                ...(parsed.changes !== undefined ? { changes: parsed.changes } : {}),
              },
              guard as never,
            );
            if (result.outcome === "target_unavailable")
              return yield* new ScheduleNotAvailable({ scheduleId: parsed.scheduleId ?? "" });
            return { outcome: result.outcome, draft: asSchedule(result.draft) };
          }),
        patch: (userId, input, guard) =>
          Effect.gen(function* () {
            if (!(yield* policy.can(userId, "schedules")))
              return yield* new DraftRejected({ reason: "schedule editing is unavailable" });
            const parsed = yield* Schema.decodeUnknownEffect(PatchScheduleDraftInput)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(
                () => new DraftRejected({ reason: "invalid schedule draft changes" }),
              ),
            );
            const result = yield* core.patch<ScheduleDraftSettings, never, never>(
              userId,
              config(userId),
              parsed,
              guard as never,
            );
            return { outcome: result.outcome, draft: asSchedule(result.draft) };
          }),
        save: Effect.fn("ScheduleDraftService.save")(function* (userId, input) {
          const parsed = yield* revisionInput(input).pipe(
            Effect.mapError(() => new DraftRejected({ reason: "invalid schedule draft revision" })),
          );
          let savedId: string | null = null;
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (!(yield* policy.can(userId, "schedules", tx)))
                  return yield* new DraftRejected({ reason: "schedule editing is unavailable" });
                const draft = asSchedule(yield* core.lock(tx, userId, parsed.draftId, "schedule"));
                // A newer draft always wins over an older receipt, even if that
                // older request once succeeded.
                if (draft.revision !== parsed.expectedRevision)
                  return { outcome: "conflict" as const, draft };
                if (draft.savedDraftRevision === draft.revision && draft.targetId !== null)
                  return { outcome: "saved" as const, draft, scheduleId: draft.targetId };
                const saved = yield* Effect.gen(function* () {
                  const settings = yield* validateScheduleSettings(
                    { providers, agents, policy },
                    userId,
                    draft.settings,
                  );
                  yield* checkScheduleResources(tx, userId, settings);
                  if (draft.targetId === null) {
                    const row = yield* repo.insert(
                      {
                        userId,
                        ...settings,
                        nextFireAt: firstFireAt(settings),
                      },
                      tx,
                    );
                    return { outcome: "saved" as const, scheduleId: row.id };
                  }
                  const row = yield* repo.update(
                    userId,
                    draft.targetId,
                    {
                      ...settings,
                      nextFireAt: firstFireAt(settings),
                    },
                    tx,
                  );
                  if (!row) return yield* new ScheduleNotAvailable({ scheduleId: draft.targetId });
                  return { outcome: "saved" as const, scheduleId: row.id };
                }).pipe(
                  Effect.catchTag("ScheduleNotAvailable", () =>
                    Effect.succeed({ outcome: "schedule_unavailable" as const }),
                  ),
                  Effect.catchTag("ScheduleRejected", ({ reason }) =>
                    Effect.succeed({ outcome: "invalid" as const, reason }),
                  ),
                );
                if (saved.outcome !== "saved") return { ...saved, draft };
                const updated = asSchedule(
                  yield* core.write(tx, draft.id, {
                    targetId: saved.scheduleId,
                    savedDraftRevision: draft.revision,
                  }),
                );
                savedId = saved.scheduleId;
                return { outcome: "saved" as const, draft: updated, scheduleId: saved.scheduleId };
              }),
            )
            .pipe(
              Effect.catchTag("EffectDrizzleQueryError", Effect.die),
              Effect.catchTag("SqlError", Effect.die),
            );
          if (savedId !== null) {
            yield* changedSchedule(userId, savedId);
            yield* core.changed(userId, result.draft);
          }
          return result;
        }),
        reload: Effect.fn("ScheduleDraftService.reload")(function* (userId, input) {
          if (!(yield* policy.can(userId, "schedules")))
            return yield* new DraftRejected({ reason: "schedule editing is unavailable" });
          const parsed = yield* revisionInput(input).pipe(
            Effect.mapError(() => new DraftRejected({ reason: "invalid schedule draft revision" })),
          );
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (!(yield* policy.can(userId, "schedules", tx)))
                  return yield* new DraftRejected({ reason: "schedule editing is unavailable" });
                const draft = asSchedule(yield* core.lock(tx, userId, parsed.draftId, "schedule"));
                if (draft.revision !== parsed.expectedRevision)
                  return { outcome: "conflict" as const, draft };
                if (draft.targetId === null) return { outcome: "no_target" as const, draft };
                const target = yield* repo.get(userId, draft.targetId, tx);
                if (!target) return { outcome: "schedule_unavailable" as const, draft };
                return {
                  outcome: "reloaded" as const,
                  draft: asSchedule(
                    yield* core.write(tx, draft.id, {
                      settings: scheduleToSettings(target),
                      revision: draft.revision + 1,
                    }),
                  ),
                };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          if (result.outcome === "reloaded") yield* core.changed(userId, result.draft);
          return result;
        }),
        discard: (userId, draftId) =>
          core
            .discard(userId, draftId, "schedule", (tx) =>
              policy
                .can(userId, "schedules", tx)
                .pipe(
                  Effect.flatMap((allowed) =>
                    allowed
                      ? Effect.void
                      : Effect.fail(
                          new DraftRejected({ reason: "schedule editing is unavailable" }),
                        ),
                  ),
                ),
            )
            .pipe(Effect.asVoid),
      });
    }),
  ).pipe(Layer.provide(DraftService.layer), Layer.provideMerge(ScheduleRepo.layer));
}
