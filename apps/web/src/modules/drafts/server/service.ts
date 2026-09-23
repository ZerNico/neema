import { Context, Effect, Layer } from "effect";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import {
  DraftNotAvailable,
  DraftRejected,
  type ConversationDraft,
  type DraftKind,
} from "../draft-schema.ts";
import { DraftRepo } from "./repo.ts";

export type DraftWriteGuard<E = never, R = never> = (tx: DbTx) => Effect.Effect<unknown, E, R>;
export type DraftError = DraftNotAvailable | DraftRejected;

/** What a kind of draft needs from the generic machinery; the rest lives here. */
export interface DraftKindConfig<S> {
  kind: DraftKind;
  /** A fresh draft's settings; also the blank-reuse baseline for `open`. */
  empty: S;
  /**
   * Settings for a new draft editing `targetId`: a snapshot of the target, or
   * the empty draft for a creation. Runs inside the open transaction after
   * `checkTarget` has passed.
   */
  initialSettings?(targetId: string, tx: DbTx): Effect.Effect<S, DraftError>;
  /** Rejection text when the target of `open` is not usable; null when fine. */
  checkTarget?: (targetId: string, tx: DbTx) => Effect.Effect<number | null, DraftError>;
}

export interface OpenDraftInput {
  conversationId: string;
  /** The answer whose tool call opens it; rewinding that answer removes the draft. */
  createdByMessageId: string;
  targetId?: string | undefined;
  changes?: Record<string, unknown> | undefined;
}
export interface PatchDraftInput {
  draftId: string;
  expectedRevision: number;
  changes: Record<string, unknown>;
}
export type OpenDraftResult<S> =
  | { outcome: "drafted" | "read"; draft: ConversationDraft<S> }
  | { outcome: "target_unavailable" };

/**
 * The machinery every conversation draft shares: idempotent open (same target
 * resolves to its draft; an untargeted open reuses an untouched blank one),
 * CAS patch, discard, and the sync invalidation after any mutation. `save` and
 * `reload` stay with the per-kind services; they validate and write the live
 * resource, which is exactly what differs between kinds.
 *
 * Settings are stored opaque and re-checked against `empty`'s shape on the
 * paths that merge them; the per-kind services decode fully on save.
 */
export class DraftService extends Context.Service<
  DraftService,
  {
    get<S>(userId: string, draftId: string): Effect.Effect<ConversationDraft<S> | null>;
    list<S>(userId: string, conversationId: string, kind: DraftKind): Effect.Effect<ConversationDraft<S>[]>;
    open<S, E = never, R = never>(
      userId: string,
      config: DraftKindConfig<S>,
      input: OpenDraftInput,
      guard: DraftWriteGuard<E, R>,
    ): Effect.Effect<OpenDraftResult<S>, DraftError | E, R>;
    patch<S, E = never, R = never>(
      userId: string,
      config: DraftKindConfig<S>,
      input: PatchDraftInput,
      guard?: DraftWriteGuard<E, R>,
    ): Effect.Effect<{ outcome: "updated" | "unchanged" | "conflict"; draft: ConversationDraft<S> }, DraftError | E, R>;
    discard(userId: string, draftId: string): Effect.Effect<ConversationDraft, DraftError>;
    /** Per-kind services call this after their own mutations. */
    changed(userId: string, draft: Pick<ConversationDraft, "id" | "conversationId" | "kind">): Effect.Effect<void>;
    lock<S>(tx: DbTx, userId: string, draftId: string): Effect.Effect<ConversationDraft<S>, DraftNotAvailable>;
    write<S>(tx: DbTx, draftId: string, changes: Partial<ConversationDraft<S>>): Effect.Effect<ConversationDraft<S>>;
  }
>()("chat/drafts/DraftService") {
  static readonly layer = Layer.effect(
    DraftService,
    Effect.gen(function* () {
      const db = yield* Db;
      const drafts = yield* DraftRepo;
      const bus = yield* SyncBus;
      const changed: DraftService["Service"]["changed"] = (userId, draft) =>
        bus
          .publish(userId, {
            type: "draft.changed",
            kind: draft.kind,
            conversationId: draft.conversationId,
            draftId: draft.id,
          })
          .pipe(Effect.catchCause(() => Effect.logWarning("draft invalidation failed")));
      const blank = <S>(config: DraftKindConfig<S>, draft: ConversationDraft<S>) =>
        draft.targetId === null &&
        draft.revision === 1 &&
        draft.savedDraftRevision === null &&
        Object.entries(config.empty as Record<string, unknown>).every(
          ([field, empty]) =>
            JSON.stringify((draft.settings as Record<string, unknown>)[field]) ===
            JSON.stringify(empty),
        );
      return DraftService.of({
        get: (userId, draftId) =>
          drafts.get(userId, draftId) as Effect.Effect<ConversationDraft<never> | null>,
        list: (userId, conversationId, kind) =>
          drafts.listForConversation(userId, conversationId, kind) as Effect.Effect<
            ConversationDraft<never>[]
          >,
        changed,
        lock: (tx, userId, draftId) =>
          drafts.lock(tx, userId, draftId) as Effect.Effect<
            ConversationDraft<never>,
            DraftNotAvailable
          >,
        write: (tx, draftId, changes) =>
          drafts.write(tx, draftId, changes) as Effect.Effect<ConversationDraft<never>>,
        open: <S, E = never, R = never>(
          userId: string,
          config: DraftKindConfig<S>,
          input: OpenDraftInput,
          guard: DraftWriteGuard<E, R>,
        ) =>
          Effect.gen(function* () {
            const result = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  yield* guard(tx);
                  yield* drafts.lockConversation(tx, userId, input.conversationId);
                  // Opening stays idempotent because the model repeats this call
                  // when unsure: the same target resolves to the draft holding it,
                  // and an untargeted call reuses an untouched blank draft.
                  const siblings = (yield* drafts.listForConversation(
                    userId,
                    input.conversationId,
                    config.kind,
                  )) as ConversationDraft<S>[];
                  const targetId = input.targetId ?? null;
                  const reusable = siblings.find((draft) =>
                    targetId === null ? blank(config, draft) : draft.targetId === targetId,
                  );
                  if (reusable) {
                    const locked = (yield* drafts.lock(tx, userId, reusable.id)) as ConversationDraft<S>;
                    // A blank draft has nothing to lose, so the changes this call
                    // carried still land. A draft already holding a target keeps
                    // its settings: those may be the user's own edits.
                    const apply = targetId === null && input.changes;
                    return {
                      outcome: "read" as const,
                      draft: apply
                        ? ((yield* drafts.write(tx, locked.id, {
                            settings: { ...locked.settings, ...input.changes },
                          })) as ConversationDraft<S>)
                        : locked,
                    };
                  }
                  const targetRevision =
                    targetId !== null && config.checkTarget
                      ? yield* config.checkTarget(targetId, tx)
                      : null;
                  if (targetId !== null && config.checkTarget && targetRevision === null)
                    return { outcome: "target_unavailable" as const };
                  const base =
                    targetId !== null && config.initialSettings
                      ? yield* config.initialSettings(targetId, tx)
                      : config.empty;
                  return {
                    outcome: "drafted" as const,
                    draft: (yield* drafts.initialize(
                      tx,
                      userId,
                      input.conversationId,
                      input.createdByMessageId,
                      config.kind,
                      { ...base, ...input.changes },
                      targetId,
                      targetRevision,
                    )) as ConversationDraft<S>,
                  };
                }),
              )
              .pipe(Effect.catchTag("SqlError", Effect.die));
            if (result.outcome === "drafted") yield* changed(userId, result.draft);
            return result;
          }),
        patch: <S, E = never, R = never>(
          userId: string,
          _config: DraftKindConfig<S>,
          input: PatchDraftInput,
          guard?: DraftWriteGuard<E, R>,
        ) =>
          Effect.gen(function* () {
            const result = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  // Keep fence failures outside recoverable validation/conflict handling.
                  if (guard) yield* guard(tx);
                  const draft = (yield* drafts.lock(tx, userId, input.draftId)) as ConversationDraft<S>;
                  if (draft.revision !== input.expectedRevision)
                    return { outcome: "conflict" as const, draft };
                  const current = draft.settings as Record<string, unknown>;
                  if (
                    Object.entries(input.changes).every(
                      ([field, value]) => JSON.stringify(value) === JSON.stringify(current[field]),
                    )
                  )
                    return { outcome: "unchanged" as const, draft };
                  return {
                    outcome: "updated" as const,
                    draft: (yield* drafts.write(tx, draft.id, {
                      settings: { ...current, ...input.changes },
                      revision: draft.revision + 1,
                    })) as ConversationDraft<S>,
                  };
                }),
              )
              .pipe(Effect.catchTag("SqlError", Effect.die));
            if (result.outcome === "updated") yield* changed(userId, result.draft);
            return result;
          }),
        discard: Effect.fn("DraftService.discard")(function* (userId, draftId) {
          const draft = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const locked = yield* drafts.lock(tx, userId, draftId);
                yield* drafts.remove(tx, locked.id);
                return locked;
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* changed(userId, draft);
          return draft;
        }),
      });
    }),
  ).pipe(Layer.provide(DraftRepo.layer));
}
