import { Context, Effect, Layer, Schema } from "effect";
import { DraftService, type DraftKindConfig } from "~/modules/drafts/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import {
  EMPTY_AGENT_DRAFT,
  OpenAgentDraftInput,
  PatchAgentDraftInput,
  AgentDraftRevisionInput,
  type AgentDraft,
  type DraftSettings,
  type OpenAgentDraftResult,
  type PatchAgentDraftResult,
  type ReloadAgentDraftResult,
  type SaveAgentDraftResult,
} from "../draft-schema.ts";
import { AgentNotAvailable } from "../errors.ts";
import { AgentRepo } from "./repo.ts";
import { storedAgentToDraftSettings } from "./draft-map.ts";
import { validateAgentSettings } from "./service.ts";
import { DraftNotAvailable, DraftRejected, type ConversationDraft } from "~/modules/drafts/draft-schema.ts";

// The generic store keeps settings opaque; every row this service touches is
// kind "agent", written only from DraftSettings, so the cast is the decode.
const asAgent = (draft: ConversationDraft): AgentDraft => ({
  ...draft,
  kind: "agent" as const,
  settings: draft.settings as DraftSettings,
});

const agentConfig = (
  agents: AgentRepo["Service"],
  userId: string,
): DraftKindConfig<DraftSettings> => ({
  kind: "agent",
  empty: EMPTY_AGENT_DRAFT,
  // Editing an existing agent starts from its stored settings, so the model
  // and the user review the live configuration, not a blank form.
  initialSettings: (agentId, tx) =>
    agents.get(userId, agentId, tx).pipe(
      Effect.map((target) => (target ? storedAgentToDraftSettings(target) : EMPTY_AGENT_DRAFT)),
    ),
  // The target must be an owned agent; the current revision becomes the
  // draft's optimistic-concurrency baseline for its first save.
  checkTarget: (agentId, tx) =>
    agents.get(userId, agentId, tx).pipe(
      Effect.map((target) =>
        target && target.row.userId === userId ? target.row.configRevision : null,
      ),
    ),
});

export class AgentDraftService extends Context.Service<
  AgentDraftService,
  {
    get(userId: string, draftId: string): Effect.Effect<AgentDraft | null>;
    list(userId: string, conversationId: string): Effect.Effect<AgentDraft[]>;
    open<E = never, R = never>(
      userId: string,
      input: OpenAgentDraftInput,
      guard: (tx: never) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<OpenAgentDraftResult, DraftNotAvailable | DraftRejected | AgentNotAvailable | E, R>;
    patch<E = never, R = never>(
      userId: string,
      input: PatchAgentDraftInput,
      guard?: (tx: never) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<PatchAgentDraftResult, DraftNotAvailable | DraftRejected | E, R>;
    save(
      userId: string,
      input: AgentDraftRevisionInput,
    ): Effect.Effect<SaveAgentDraftResult, DraftNotAvailable | DraftRejected>;
    reload(
      userId: string,
      input: AgentDraftRevisionInput,
    ): Effect.Effect<ReloadAgentDraftResult, DraftNotAvailable | DraftRejected>;
    /**
     * Destroys one draft. By id and unconditional: the user confirmed this
     * specific draft by name, and a revision that moved underneath does not
     * make destroying it wrong. Saved agents are untouched.
     */
    discard(userId: string, draftId: string): Effect.Effect<void, DraftNotAvailable | DraftRejected>;
  }
>()("chat/agents/AgentDraftService") {
  static readonly layer = Layer.effect(
    AgentDraftService,
    Effect.gen(function* () {
      const db = yield* Db;
      const core: DraftService["Service"] = yield* DraftService;
      const agents = yield* AgentRepo;
      const providers = yield* ProviderRepo;
      const bus = yield* SyncBus;
      const revisionInput = Schema.decodeUnknownEffect(AgentDraftRevisionInput);
      const config = (userId: string) => agentConfig(agents, userId);
      return AgentDraftService.of({
        get: (userId, draftId) =>
          core.get(userId, draftId).pipe(Effect.map((draft) => (draft ? asAgent(draft) : null))),
        list: (userId, conversationId) =>
          core.list(userId, conversationId, "agent").pipe(Effect.map((rows) => rows.map(asAgent))),
        open: (userId, input, guard) =>
          Effect.gen(function* () {
            const parsed = yield* Schema.decodeUnknownEffect(OpenAgentDraftInput)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(() => new DraftRejected({ reason: "invalid agent draft request" })),
            );
            const result = yield* core.open<DraftSettings, never, never>(
              userId,
              config(userId),
              {
                conversationId: parsed.conversationId,
                ...(parsed.agentId !== undefined ? { targetId: parsed.agentId } : {}),
                ...(parsed.changes !== undefined ? { changes: parsed.changes } : {}),
              },
              guard as never,
            );
            if (result.outcome === "target_unavailable")
              return yield* new AgentNotAvailable({ agentId: parsed.agentId ?? "" });
            return { outcome: result.outcome, draft: asAgent(result.draft) };
          }),
        patch: (userId, input, guard) =>
          Effect.gen(function* () {
            const parsed = yield* Schema.decodeUnknownEffect(PatchAgentDraftInput)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(() => new DraftRejected({ reason: "invalid agent draft changes" })),
            );
            const result = yield* core.patch<DraftSettings, never, never>(
              userId,
              config(userId),
              parsed,
              guard as never,
            );
            return { outcome: result.outcome, draft: asAgent(result.draft) };
          }),
        save: Effect.fn("AgentDraftService.save")(function* (userId, input) {
          const parsed = yield* revisionInput(input).pipe(
            Effect.mapError(() => new DraftRejected({ reason: "invalid agent draft revision" })),
          );
          let changed = false;
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const draft = asAgent(yield* core.lock(tx, userId, parsed.draftId));
                // A newer draft always wins over an older receipt, even if that older
                // request once succeeded. Never approve contents the user did not see.
                if (draft.revision !== parsed.expectedRevision)
                  return { outcome: "conflict" as const, draft };
                if (
                  draft.savedDraftRevision === draft.revision &&
                  draft.targetId !== null &&
                  draft.targetRevision !== null
                )
                  return {
                    outcome: "saved" as const,
                    draft,
                    agentId: draft.targetId,
                    configRevision: draft.targetRevision,
                  };
                const saved = yield* Effect.gen(function* () {
                  // Working input may hold a starter row nobody filled in. Drop
                  // those on the way to the agent, which requires real ones; the
                  // draft keeps what the user reviewed.
                  const settings = yield* validateAgentSettings(providers, userId, {
                    ...draft.settings,
                    starters: draft.settings.starters.filter((starter) => starter.trim()),
                  });
                  return {
                    outcome: "saved" as const,
                    ...(yield* agents.saveInTransaction(
                      tx,
                      userId,
                      settings,
                      draft.targetId === null
                        ? undefined
                        : {
                            agentId: draft.targetId,
                            expectedRevision: draft.targetRevision!,
                          },
                    )),
                  };
                }).pipe(
                  Effect.catchTag("AgentNotAvailable", () =>
                    Effect.succeed({ outcome: "agent_unavailable" as const }),
                  ),
                  Effect.catchTag("AgentRejected", ({ reason }) =>
                    Effect.succeed(
                      reason === "agent changed; reload before saving"
                        ? { outcome: "agent_changed" as const }
                        : { outcome: "invalid" as const, reason },
                    ),
                  ),
                );
                if (saved.outcome !== "saved") return { ...saved, draft };
                const updated = asAgent(
                  yield* core.write(tx, draft.id, {
                    targetId: saved.agentId,
                    targetRevision: saved.configRevision,
                    savedDraftRevision: draft.revision,
                  }),
                );
                changed = true;
                return { ...saved, draft: updated };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          if (changed) {
            yield* bus
              .publishGlobal({ type: "resources.changed" })
              .pipe(Effect.catchCause(() => Effect.logWarning("agent resource invalidation failed")));
            yield* core.changed(userId, result.draft);
          }
          return result;
        }),
        reload: Effect.fn("AgentDraftService.reload")(function* (userId, input) {
          const parsed = yield* revisionInput(input).pipe(
            Effect.mapError(() => new DraftRejected({ reason: "invalid agent draft revision" })),
          );
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const draft = asAgent(yield* core.lock(tx, userId, parsed.draftId));
                if (draft.revision !== parsed.expectedRevision)
                  return { outcome: "conflict" as const, draft };
                if (draft.targetId === null) return { outcome: "no_target" as const, draft };
                const target = yield* agents.get(userId, draft.targetId, tx);
                if (!target || target.row.userId !== userId)
                  return { outcome: "agent_unavailable" as const, draft };
                return {
                  outcome: "reloaded" as const,
                  draft: asAgent(
                    yield* core.write(tx, draft.id, {
                      settings: storedAgentToDraftSettings(target),
                      targetRevision: target.row.configRevision,
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
        discard: (userId, draftId) => core.discard(userId, draftId).pipe(Effect.asVoid),
      });
    }),
  ).pipe(Layer.provide(DraftService.layer), Layer.provide(AgentRepo.layer));
}
