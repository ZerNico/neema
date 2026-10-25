import { Context, Effect, Layer, Schema, type SchemaAST } from "effect";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db, type DbTx } from "~/server/db.ts";
import {
  DraftNotAvailable,
  DraftRejected,
  type ConversationDraft,
  type DraftKind,
} from "../draft-schema.ts";
import { DraftRepo } from "./repo.ts";
import type { Localized } from "~/i18n/localized.ts";

export type DraftWriteGuard<E = never, R = never> = (tx: DbTx) => Effect.Effect<unknown, E, R>;
export type DraftError = DraftNotAvailable | DraftRejected;

/** What a kind of draft needs from the generic machinery; the rest lives here. */
export interface DraftKindConfig<S> {
  kind: DraftKind;
  /** A fresh draft's settings; also the blank-reuse baseline for `open`. */
  empty: S;
  /**
   * The target a new draft edits, read once inside the open transaction: its
   * settings, which the draft starts from, and its config revision, which the
   * draft's first save must still find. Null when it is not the person's to edit.
   */
  readTarget(
    targetId: string,
    tx: DbTx,
  ): Effect.Effect<{ settings: S; revision: number } | null, DraftError>;
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

const blank = <S>(config: DraftKindConfig<S>, draft: ConversationDraft<S>) =>
  draft.targetId === null &&
  draft.revision === 1 &&
  draft.savedDraftRevision === null &&
  Object.entries(config.empty as Record<string, unknown>).every(
    ([field, empty]) =>
      JSON.stringify((draft.settings as Record<string, unknown>)[field]) === JSON.stringify(empty),
  );

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
    get<S>(
      userId: string,
      draftId: string,
      kind: DraftKind,
    ): Effect.Effect<ConversationDraft<S> | null>;
    list<S>(
      userId: string,
      conversationId: string,
      kind: DraftKind,
    ): Effect.Effect<ConversationDraft<S>[]>;
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
    ): Effect.Effect<
      { outcome: "updated" | "unchanged" | "conflict"; draft: ConversationDraft<S> },
      DraftError | E,
      R
    >;
    discard<E = never, R = never>(
      userId: string,
      draftId: string,
      kind: DraftKind,
      guard: DraftWriteGuard<E, R>,
    ): Effect.Effect<ConversationDraft, DraftError | E, R>;
    /** Per-kind services call this after their own mutations. */
    changed(
      userId: string,
      draft: Pick<ConversationDraft, "id" | "conversationId" | "kind">,
    ): Effect.Effect<void>;
    lock<S>(
      tx: DbTx,
      userId: string,
      draftId: string,
      kind: DraftKind,
    ): Effect.Effect<ConversationDraft<S>, DraftNotAvailable>;
    write<S>(
      tx: DbTx,
      draftId: string,
      changes: Partial<ConversationDraft<S>>,
    ): Effect.Effect<ConversationDraft<S>>;
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
      return DraftService.of({
        get: (userId, draftId, kind) =>
          drafts.get(userId, draftId, kind) as Effect.Effect<ConversationDraft<never> | null>,
        list: (userId, conversationId, kind) =>
          drafts.listForConversation(userId, conversationId, kind) as Effect.Effect<
            ConversationDraft<never>[]
          >,
        changed,
        lock: (tx, userId, draftId, kind) =>
          drafts.lock(tx, userId, draftId, kind) as Effect.Effect<
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
                    tx,
                  )) as ConversationDraft<S>[];
                  const targetId = input.targetId ?? null;
                  const reusable = siblings.find((draft) =>
                    targetId === null ? blank(config, draft) : draft.targetId === targetId,
                  );
                  if (reusable) {
                    const locked = (yield* drafts.lock(
                      tx,
                      userId,
                      reusable.id,
                      config.kind,
                    )) as ConversationDraft<S>;
                    // A blank draft has nothing to lose, so the changes this call
                    // carried still land. A draft already holding a target keeps
                    // its settings: those may be the user's own edits.
                    const current = locked.settings as Record<string, unknown>;
                    const settingsChanged =
                      targetId === null &&
                      input.changes &&
                      Object.entries(input.changes).some(
                        ([field, value]) =>
                          JSON.stringify(value) !== JSON.stringify(current[field]),
                      );
                    return settingsChanged
                      ? {
                          outcome: "drafted" as const,
                          draft: (yield* drafts.write(tx, locked.id, {
                            settings: { ...current, ...input.changes },
                            revision: locked.revision + 1,
                          })) as ConversationDraft<S>,
                        }
                      : { outcome: "read" as const, draft: locked };
                  }
                  const target = targetId === null ? null : yield* config.readTarget(targetId, tx);
                  if (targetId !== null && target === null)
                    return { outcome: "target_unavailable" as const };
                  return {
                    outcome: "drafted" as const,
                    draft: (yield* drafts.initialize(
                      tx,
                      userId,
                      input.conversationId,
                      input.createdByMessageId,
                      config.kind,
                      { ...(target?.settings ?? config.empty), ...input.changes },
                      targetId,
                      target?.revision ?? null,
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
          config: DraftKindConfig<S>,
          input: PatchDraftInput,
          guard?: DraftWriteGuard<E, R>,
        ) =>
          Effect.gen(function* () {
            const result = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  // Keep fence failures outside recoverable validation/conflict handling.
                  if (guard) yield* guard(tx);
                  const draft = (yield* drafts.lock(
                    tx,
                    userId,
                    input.draftId,
                    config.kind,
                  )) as ConversationDraft<S>;
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
        discard: <E = never, R = never>(
          userId: string,
          draftId: string,
          kind: DraftKind,
          guard: DraftWriteGuard<E, R>,
        ) =>
          Effect.gen(function* () {
            const draft = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  yield* guard(tx);
                  const locked = yield* drafts.lock(tx, userId, draftId, kind);
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

/** Decodes a kind's request; a malformed one is rejected with the kind's own text. */
export const decodeDraftRequest =
  <S extends Schema.Codec<unknown, unknown, never, never>>(
    schema: S,
    reason: Localized,
    options?: SchemaAST.ParseOptions,
  ) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input, options).pipe(
      Effect.mapError(() => new DraftRejected({ reason })),
    );

/**
 * A kind's `get` and `list`: a reader who may not author the kind sees no
 * drafts rather than an error, so a revoked capability empties the panel.
 */
export const allowedDraftReads = <D>(config: {
  core: DraftService["Service"];
  kind: DraftKind;
  allowed: (userId: string) => Effect.Effect<boolean>;
  /** The kind's view of a stored row, whose settings the store keeps opaque. */
  cast: (draft: ConversationDraft) => D;
}) => ({
  get: (userId: string, draftId: string): Effect.Effect<D | null> =>
    config
      .allowed(userId)
      .pipe(
        Effect.flatMap((allowed) =>
          allowed
            ? config.core
                .get(userId, draftId, config.kind)
                .pipe(Effect.map((draft) => (draft ? config.cast(draft) : null)))
            : Effect.succeed(null),
        ),
      ),
  list: (userId: string, conversationId: string): Effect.Effect<D[]> =>
    config
      .allowed(userId)
      .pipe(
        Effect.flatMap((allowed) =>
          allowed
            ? config.core
                .list(userId, conversationId, config.kind)
                .pipe(Effect.map((rows) => rows.map(config.cast)))
            : Effect.succeed([]),
        ),
      ),
});
