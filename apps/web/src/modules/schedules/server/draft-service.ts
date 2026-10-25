import { Context, Effect, Layer } from "effect";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import {
  DraftNotAvailable,
  DraftRejected,
  type ConversationDraft,
} from "~/modules/drafts/draft-schema.ts";
import {
  DraftService,
  allowedDraftReads,
  decodeDraftRequest,
  type DraftKindConfig,
} from "~/modules/drafts/server/service.ts";
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
import { ScheduleNotAvailable, scheduleToSettings } from "../schema.ts";
import { type Localized, localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { ScheduleRepo } from "./repo.ts";
import { checkScheduleResources, firstFireAt, validateScheduleSettings } from "./validate.ts";

// The generic store keeps settings opaque; every row this service touches is
// kind "schedule", written only from ScheduleDraftSettings, so the cast is the
// decode.
const asSchedule = (draft: ConversationDraft): ScheduleDraft => ({
  ...draft,
  kind: "schedule" as const,
  settings: draft.settings as ScheduleDraftSettings,
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
    ): Effect.Effect<SaveScheduleDraftResult<Localized>, DraftNotAvailable | DraftRejected>;
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
      const revisionInput = decodeDraftRequest(
        ScheduleDraftRevisionInput,
        localized(m.schedules_error_draft_revision),
      );
      const openInput = decodeDraftRequest(
        OpenScheduleDraftInput,
        localized(m.schedules_error_draft_request),
        { onExcessProperty: "error" },
      );
      const patchInput = decodeDraftRequest(
        PatchScheduleDraftInput,
        localized(m.schedules_error_draft_changes),
        { onExcessProperty: "error" },
      );

      const config = (userId: string): DraftKindConfig<ScheduleDraftSettings> => ({
        kind: "schedule",
        empty: EMPTY_SCHEDULE_DRAFT,
        // Editing an existing schedule starts from its stored settings, so the
        // model and the user review the live configuration, not a blank form.
        readTarget: (scheduleId, tx) =>
          repo
            .get(userId, scheduleId, tx)
            .pipe(
              Effect.map((row) =>
                row ? { settings: scheduleToSettings(row), revision: row.configRevision } : null,
              ),
            ),
      });

      const changedSchedule = (userId: string, scheduleId: string) =>
        bus
          .publish(userId, { type: "schedule.changed", scheduleId })
          .pipe(Effect.catchCause(() => Effect.logWarning("schedule invalidation failed")));

      return ScheduleDraftService.of({
        ...allowedDraftReads({
          core,
          kind: "schedule",
          allowed: (userId) => policy.can(userId, "schedules"),
          cast: asSchedule,
        }),
        open: (userId, input, guard) =>
          Effect.gen(function* () {
            if (!(yield* policy.can(userId, "schedules")))
              return yield* new ScheduleNotAvailable({ scheduleId: "" });
            const parsed = yield* openInput(input);
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
              return yield* new DraftRejected({
                reason: localized(m.schedules_error_editing_unavailable),
              });
            const parsed = yield* patchInput(input);
            const result = yield* core.patch<ScheduleDraftSettings, never, never>(
              userId,
              config(userId),
              parsed,
              guard as never,
            );
            return { outcome: result.outcome, draft: asSchedule(result.draft) };
          }),
        save: Effect.fn("ScheduleDraftService.save")(function* (userId, input) {
          const parsed = yield* revisionInput(input);
          let savedId: string | null = null;
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (!(yield* policy.can(userId, "schedules", tx)))
                  return yield* new DraftRejected({
                    reason: localized(m.schedules_error_editing_unavailable),
                  });
                const draft = asSchedule(yield* core.lock(tx, userId, parsed.draftId, "schedule"));
                // A newer draft always wins over an older receipt, even if that
                // older request once succeeded.
                if (draft.revision !== parsed.expectedRevision)
                  return { outcome: "conflict" as const, draft };
                if (
                  draft.savedDraftRevision === draft.revision &&
                  draft.targetId !== null &&
                  draft.targetRevision !== null
                )
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
                      { userId, ...settings, nextFireAt: firstFireAt(settings) },
                      tx,
                    );
                    return { outcome: "saved" as const, scheduleId: row.id, row };
                  }
                  const row = yield* repo.update(
                    userId,
                    draft.targetId,
                    { ...settings, nextFireAt: firstFireAt(settings) },
                    tx,
                    draft.targetRevision ?? 0,
                  );
                  return { outcome: "saved" as const, scheduleId: row.id, row };
                }).pipe(
                  Effect.catchTag("ScheduleChanged", () =>
                    Effect.succeed({ outcome: "schedule_changed" as const }),
                  ),
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
                    targetRevision: saved.row.configRevision,
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
          const parsed = yield* revisionInput(input);
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (!(yield* policy.can(userId, "schedules", tx)))
                  return yield* new DraftRejected({
                    reason: localized(m.schedules_error_editing_unavailable),
                  });
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
                      targetRevision: target.configRevision,
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
                          new DraftRejected({
                            reason: localized(m.schedules_error_editing_unavailable),
                          }),
                        ),
                  ),
                ),
            )
            .pipe(Effect.asVoid),
      });
    }),
  ).pipe(Layer.provide(DraftService.layer), Layer.provideMerge(ScheduleRepo.layer));
}
