import { Context, Effect, Layer, Schema } from "effect";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import {
  AgentDraftRejected,
  EMPTY_AGENT_DRAFT,
  type DraftSettings,
  AgentDraftRevisionInput,
  PatchAgentDraftInput,
  OpenAgentDraftInput,
  type OpenAgentDraftResult,
  type AgentDraft,
  type AgentDraftNotAvailable,
  type PatchAgentDraftResult,
  type ReloadAgentDraftResult,
  type SaveAgentDraftResult,
} from "../draft-schema.ts";
import type { AgentNotAvailable } from "../errors.ts";
import { AgentDraftRepo, storedAgentToDraftSettings } from "./draft-repo.ts";
import { AgentRepo } from "./repo.ts";
import { validateAgentSettings } from "./service.ts";

export type AgentDraftWriteGuard<E = never, R = never> = (tx: DbTx) => Effect.Effect<unknown, E, R>;
type DraftError = AgentDraftNotAvailable | AgentDraftRejected;

export class AgentDraftService extends Context.Service<
  AgentDraftService,
  {
    get(userId: string, draftId: string): Effect.Effect<AgentDraft | null>;
    list(userId: string, conversationId: string): Effect.Effect<AgentDraft[]>;
    open<E = never, R = never>(
      userId: string,
      input: OpenAgentDraftInput,
      guard: AgentDraftWriteGuard<E, R>,
    ): Effect.Effect<OpenAgentDraftResult, DraftError | AgentNotAvailable | E, R>;
    patch<E = never, R = never>(
      userId: string,
      input: PatchAgentDraftInput,
      guard?: AgentDraftWriteGuard<E, R>,
    ): Effect.Effect<PatchAgentDraftResult, DraftError | E, R>;
    save(
      userId: string,
      input: AgentDraftRevisionInput,
    ): Effect.Effect<SaveAgentDraftResult, DraftError>;
    reload(
      userId: string,
      input: AgentDraftRevisionInput,
    ): Effect.Effect<ReloadAgentDraftResult, DraftError>;
    /**
     * Destroys one draft. By id and unconditional: the user confirmed this
     * specific draft by name, and a revision that moved underneath does not
     * make destroying it wrong. Saved agents are untouched.
     */
    discard(userId: string, draftId: string): Effect.Effect<void, DraftError>;
  }
>()("chat/agents/AgentDraftService") {
  static readonly layer = Layer.effect(
    AgentDraftService,
    Effect.gen(function* () {
      const db = yield* Db;
      const drafts = yield* AgentDraftRepo;
      const agents = yield* AgentRepo;
      const providers = yield* ProviderRepo;
      const bus = yield* SyncBus;
      const draftChanged = (userId: string, draft: Pick<AgentDraft, "id" | "conversationId">) =>
        bus
          .publish(userId, {
            type: "agent.draft.changed",
            conversationId: draft.conversationId,
            draftId: draft.id,
          })
          .pipe(Effect.catchCause(() => Effect.logWarning("agent draft invalidation failed")));
      const resourcesChanged = () =>
        bus
          .publishGlobal({ type: "resources.changed" })
          .pipe(Effect.catchCause(() => Effect.logWarning("agent resource invalidation failed")));
      const revisionInput = Schema.decodeUnknownEffect(AgentDraftRevisionInput);
      return AgentDraftService.of({
        get: drafts.get,
        list: drafts.listForConversation,
        open: <E = never, R = never>(
          userId: string,
          input: OpenAgentDraftInput,
          guard: AgentDraftWriteGuard<E, R>,
        ) =>
          Effect.gen(function* () {
            const parsed = yield* Schema.decodeUnknownEffect(OpenAgentDraftInput)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(
                () => new AgentDraftRejected({ reason: "invalid agent draft request" }),
              ),
            );
            const result = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  yield* guard(tx);
                  yield* drafts.lockConversation(tx, userId, parsed.conversationId);
                  // Opening stays idempotent because the model repeats this call
                  // when unsure: the same target resolves to the draft holding it,
                  // and an untargeted call reuses an untouched blank draft.
                  const siblings = yield* drafts.listForConversation(userId, parsed.conversationId);
                  const blank = (draft: AgentDraft) =>
                    draft.targetAgentId === null &&
                    draft.revision === 1 &&
                    draft.savedDraftRevision === null &&
                    Object.entries(EMPTY_AGENT_DRAFT).every(
                      ([field, empty]) =>
                        JSON.stringify(draft.settings[field as keyof DraftSettings]) ===
                        JSON.stringify(empty),
                    );
                  const reusable = siblings.find((draft) =>
                    parsed.agentId === undefined
                      ? blank(draft)
                      : draft.targetAgentId === parsed.agentId,
                  );
                  if (reusable) {
                    const locked = yield* drafts.lock(tx, userId, reusable.id);
                    // A blank draft has nothing to lose, so the changes this call
                    // carried still land. A draft already holding a target keeps
                    // its settings: those may be the user's own edits.
                    const apply = parsed.agentId === undefined && parsed.changes;
                    return {
                      outcome: "read" as const,
                      draft: apply
                        ? yield* drafts.write(tx, locked.id, {
                            settings: { ...locked.settings, ...parsed.changes },
                          })
                        : locked,
                    };
                  }
                  return {
                    outcome: "drafted" as const,
                    draft: yield* drafts.initialize(
                      tx,
                      userId,
                      parsed.conversationId,
                      parsed.agentId ?? null,
                      parsed.changes,
                    ),
                  };
                }),
              )
              .pipe(Effect.catchTag("SqlError", Effect.die));
            if (result.outcome === "drafted") yield* draftChanged(userId, result.draft);
            return result;
          }),
        patch: <E = never, R = never>(
          userId: string,
          input: PatchAgentDraftInput,
          guard?: AgentDraftWriteGuard<E, R>,
        ) =>
          Effect.gen(function* () {
            const parsed = yield* Schema.decodeUnknownEffect(PatchAgentDraftInput)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(
                () => new AgentDraftRejected({ reason: "invalid agent draft changes" }),
              ),
            );
            const result = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  // Keep fence failures outside recoverable validation/conflict handling.
                  if (guard) yield* guard(tx);
                  const draft = yield* drafts.lock(tx, userId, parsed.draftId);
                  if (draft.revision !== parsed.expectedRevision)
                    return { outcome: "conflict" as const, draft };
                  const settings = { ...draft.settings, ...parsed.changes };
                  if (
                    Object.entries(parsed.changes).every(
                      ([field, value]) =>
                        JSON.stringify(value) ===
                        JSON.stringify(draft.settings[field as keyof typeof draft.settings]),
                    )
                  )
                    return { outcome: "unchanged" as const, draft };
                  return {
                    outcome: "updated" as const,
                    draft: yield* drafts.write(tx, draft.id, {
                      settings,
                      revision: draft.revision + 1,
                    }),
                  };
                }),
              )
              .pipe(Effect.catchTag("SqlError", Effect.die));
            if (result.outcome === "updated") yield* draftChanged(userId, result.draft);
            return result;
          }),
        save: Effect.fn("AgentDraftService.save")(function* (userId, input) {
          const parsed = yield* revisionInput(input).pipe(
            Effect.mapError(
              () => new AgentDraftRejected({ reason: "invalid agent draft revision" }),
            ),
          );
          let changed = false;
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const draft = yield* drafts.lock(tx, userId, parsed.draftId);
                // A newer draft always wins over an older receipt, even if that older
                // request once succeeded. Never approve contents the user did not see.
                if (draft.revision !== parsed.expectedRevision)
                  return { outcome: "conflict" as const, draft };
                if (
                  draft.savedDraftRevision === draft.revision &&
                  draft.targetAgentId !== null &&
                  draft.targetRevision !== null
                )
                  return {
                    outcome: "saved" as const,
                    draft,
                    agentId: draft.targetAgentId,
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
                      draft.targetAgentId === null
                        ? undefined
                        : {
                            agentId: draft.targetAgentId,
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
                const updated = yield* drafts.write(tx, draft.id, {
                  targetAgentId: saved.agentId,
                  targetRevision: saved.configRevision,
                  savedDraftRevision: draft.revision,
                });
                changed = true;
                return { ...saved, draft: updated };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          if (changed) {
            yield* resourcesChanged();
            yield* draftChanged(userId, result.draft);
          }
          return result;
        }),
        reload: Effect.fn("AgentDraftService.reload")(function* (userId, input) {
          const parsed = yield* revisionInput(input).pipe(
            Effect.mapError(
              () => new AgentDraftRejected({ reason: "invalid agent draft revision" }),
            ),
          );
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const draft = yield* drafts.lock(tx, userId, parsed.draftId);
                if (draft.revision !== parsed.expectedRevision)
                  return { outcome: "conflict" as const, draft };
                if (draft.targetAgentId === null) return { outcome: "no_target" as const, draft };
                const target = yield* agents.get(userId, draft.targetAgentId, tx);
                if (!target || target.row.userId !== userId)
                  return { outcome: "agent_unavailable" as const, draft };
                return {
                  outcome: "reloaded" as const,
                  draft: yield* drafts.write(tx, draft.id, {
                    settings: storedAgentToDraftSettings(target),
                    targetRevision: target.row.configRevision,
                    revision: draft.revision + 1,
                  }),
                };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          if (result.outcome === "reloaded") yield* draftChanged(userId, result.draft);
          return result;
        }),
        discard: Effect.fn("AgentDraftService.discard")(function* (userId, draftId) {
          const draft = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const locked = yield* drafts.lock(tx, userId, draftId);
                yield* drafts.remove(tx, locked.id);
                return locked;
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* draftChanged(userId, draft);
        }),
      });
    }),
  ).pipe(Layer.provide(AgentDraftRepo.layer), Layer.provide(AgentRepo.layer));
}
