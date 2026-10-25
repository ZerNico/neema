import { m } from "~/paraglide/messages.js";
import { leaseFor } from "~/server/sql.ts";
import { readableBy } from "~/modules/sharing/server/resources.ts";
import { alias } from "drizzle-orm/pg-core";
import { and, count, eq, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Schedule as EffectSchedule, Semaphore } from "effect";
import { uuidv7 } from "uuidv7";
import {
  integrationConfigs,
  integrationConnections,
  knowledgeCollections,
  knowledgeDocuments,
  knowledgeSources,
  type KnowledgeSourceStats,
} from "~/db/schema/index.ts";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import {
  KnowledgeRepo,
  lockKnowledgeSource,
  type SourceFence,
} from "~/modules/knowledge/server/repo.ts";
import { accountEligible } from "~/modules/auth/server/account-eligibility.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { findIntegrationType } from "../catalog.ts";
import { type Localized, localized, verbatim } from "~/i18n/localized.ts";
import { LanguageRepo } from "~/modules/language/server/repo.ts";
import { IntegrationNotAvailable, IntegrationRejected } from "../errors.ts";
import {
  accountName,
  type BrowseNode,
  type KnowledgeSourceView,
  type SourceRoot,
} from "../schema.ts";
import { isSelected, type AdapterFailure } from "./adapter.ts";
import { accountUsability } from "./credentials.ts";
import { integrationUsableBy } from "./repo.ts";
import { IntegrationService } from "./service.ts";

const TICK_INTERVAL = Duration.minutes(1);
/** How often a source is pulled again; Sync now skips the wait. */
const SYNC_EVERY = "1 hour";
/** Long enough for a large tree; a crashed sync is picked up again after it. */
const LEASE_SECONDS = 30 * 60;
const BATCH = 5;
/**
 * Overlap on the cursor: a page saved while the last listing ran can carry a
 * change time just before the newest one it returned. Re-listing a few
 * minutes is free, since an unchanged page is skipped by its stored time.
 */
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;
/** A full listing at least this often, in case a change slipped past the cursor. */
const FULL_SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

type SourceRow = typeof knowledgeSources.$inferSelect;

const failureText = (error: AdapterFailure | IntegrationNotAvailable): Localized =>
  error._tag === "IntegrationAuthFailed" || error._tag === "IntegrationNotAvailable"
    ? localized(m.integrations_sync_error_account)
    : error._tag === "IntegrationRejected"
      ? error.reason
      : // The service's own words, or the request's.
        verbatim(error.message);

export class KnowledgeSourceService extends Context.Service<
  KnowledgeSourceService,
  {
    list(userId: string, collectionId: string): Effect.Effect<ReadonlyArray<KnowledgeSourceView>>;
    /** Adds a source, or edits one, in a collection the caller owns. */
    save(
      userId: string,
      input: {
        collectionId: string;
        /** The owner's account it syncs as; editing may switch to another of theirs. */
        connectionId: string;
        /** Absent adds a source; present edits that one. */
        sourceId?: string | undefined;
        root: SourceRoot;
      },
    ): Effect.Effect<KnowledgeSourceView, IntegrationRejected | IntegrationNotAvailable>;
    /** Removes the source and every document it mirrored. */
    remove(userId: string, sourceId: string): Effect.Effect<boolean>;
    syncNow(userId: string, sourceId: string): Effect.Effect<boolean>;
    browse(
      userId: string,
      connectionId: string,
      parentId: string | null,
    ): Effect.Effect<ReadonlyArray<BrowseNode>, IntegrationRejected | IntegrationNotAvailable>;
    /** One claim-and-sync pass; the tick loop and tests drive it. */
    readonly tick: Effect.Effect<void>;
  }
>()("chat/integrations/KnowledgeSourceService") {
  /** Syncs on a timer and whenever a source is saved or asked to sync now. */
  static readonly layer = Layer.effect(KnowledgeSourceService, make(true));
  /** No background work: whoever holds it calls `tick`, as the tests do. */
  static readonly manualLayer = Layer.effect(KnowledgeSourceService, make(false));
}

const toView = (
  row: SourceRow,
  connected: boolean,
  canEdit: boolean,
  account: string | null,
): KnowledgeSourceView => ({
  id: row.id,
  canEdit,
  collectionId: row.collectionId,
  integrationId: row.integrationId,
  connectionId: row.connectionId,
  account,
  root: row.root,
  status: row.status,
  lastError: row.lastError,
  lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  stats: row.stats,
  connected,
});

function make(background: boolean) {
  return Effect.gen(function* () {
    const db = yield* Db;
    const knowledge = yield* KnowledgeRepo;
    const integrations = yield* IntegrationService;
    const bus = yield* SyncBus;
    // A sync runs with nobody watching; its outcome is kept in the owner's language.
    const languages = yield* LanguageRepo;

    const changed = bus
      .publishGlobal({ type: "knowledge.index.changed" })
      .pipe(Effect.catchCause(() => Effect.void));

    const ownedCollection = (userId: string, collectionId: string) =>
      db
        .select({ id: knowledgeCollections.id })
        .from(knowledgeCollections)
        // The same edit rule as notes and uploads: the owner, while they may create knowledge.
        .where(
          and(
            eq(knowledgeCollections.id, collectionId),
            eq(knowledgeCollections.userId, userId),
            capabilityAllowedSql(userId, "knowledgeCreate"),
          ),
        )
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.length > 0),
        );

    const list = Effect.fn("KnowledgeSourceService.list")(function* (
      userId: string,
      collectionId: string,
    ) {
      // Anyone who can read the collection sees where its pages come from;
      // only the owner changes that.
      const [collection] = yield* db
        .select({ owner: knowledgeCollections.userId })
        .from(knowledgeCollections)
        .where(and(eq(knowledgeCollections.id, collectionId), readableBy("collection", userId)))
        .pipe(Effect.orDie);
      if (!collection) return [];
      const rows = yield* db
        .select({
          source: knowledgeSources,
          connection: integrationConnections,
          config: integrationConfigs,
          // Whether the sync, which runs as the owner, may use it.
          access: sql<boolean>`${integrationUsableBy(collection.owner)}`,
        })
        .from(knowledgeSources)
        .innerJoin(integrationConfigs, eq(integrationConfigs.id, knowledgeSources.integrationId))
        // The account it syncs as, which is the owner's own.
        .leftJoin(
          integrationConnections,
          and(
            eq(integrationConnections.id, knowledgeSources.connectionId),
            eq(integrationConnections.userId, collection.owner),
          ),
        )
        .where(eq(knowledgeSources.collectionId, collectionId))
        .pipe(Effect.orDie);
      const owner = collection.owner === userId;
      return rows.map((row) => {
        // Only the owner hears which of their accounts it is.
        const account = owner && row.connection ? accountName(row.connection) : null;
        const connected =
          row.connection !== null &&
          accountUsability(row.config, Boolean(row.access), row.connection).usable;
        return toView(row.source, connected, owner, account);
      });
    });

    /** Mirrors one claimed source. Every outcome ends in `finish`. */
    const run = Effect.fn("KnowledgeSourceService.run")(function* (source: SourceRow) {
      const fence: SourceFence = {
        sourceId: source.id,
        collectionId: source.collectionId,
        integrationId: source.integrationId,
        leaseToken: source.leaseToken ?? "",
      };
      const finish = (fields: {
        status: "idle" | "error";
        lastError: string | null;
        stats?: KnowledgeSourceStats;
        cursor?: Date | null;
        fullSyncedAt?: Date;
        oversized?: Record<string, string>;
      }) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [collection] = yield* tx
                .select({ id: knowledgeCollections.id })
                .from(knowledgeCollections)
                .where(eq(knowledgeCollections.id, source.collectionId))
                .for("update");
              if (!collection || !(yield* lockKnowledgeSource(tx, fence))) return;
              yield* tx
                .update(knowledgeSources)
                .set({
                  ...fields,
                  ...(fields.status === "idle" ? { lastSyncedAt: new Date() } : {}),
                  leaseToken: null,
                  leaseUntil: null,
                  updatedAt: new Date(),
                })
                .where(eq(knowledgeSources.id, source.id));
            }),
          )
          .pipe(Effect.orDie);

      const [collection] = yield* db
        .select({ userId: knowledgeCollections.userId })
        .from(knowledgeCollections)
        .where(eq(knowledgeCollections.id, source.collectionId))
        .pipe(Effect.orDie);
      if (!collection) return yield* finish({ status: "error", lastError: null });
      const owner = collection.userId;
      // A sync acts as the owner with their credentials, so it stops when they
      // could not act themselves: banned, rejected, or no longer creating knowledge.
      const [mayCreate] = yield* db
        .select({ id: knowledgeCollections.id })
        .from(knowledgeCollections)
        .where(
          and(
            eq(knowledgeCollections.id, source.collectionId),
            capabilityAllowedSql(owner, "knowledgeCreate"),
          ),
        )
        .pipe(Effect.orDie);
      if (!mayCreate || !(yield* accountEligible(owner).pipe(Effect.provideService(Db, db))))
        return yield* finish({
          status: "error",
          lastError: m.integrations_sync_error_owner(
            {},
            { locale: yield* languages.localeOf(owner) },
          ),
        });
      // Always the owner's own chosen account; never anyone else's, nor another of theirs.
      const outcome = yield* Effect.gen(function* () {
        if (!source.connectionId)
          return yield* new IntegrationRejected({
            reason: localized(m.integrations_error_sync_account_gone),
          });
        const session = yield* integrations.session(owner, source.connectionId);
        if (session.integration.id !== source.integrationId)
          return yield* new IntegrationNotAvailable({ integrationId: source.integrationId });
        const adapter = session.adapter.knowledge;
        if (!adapter)
          return yield* new IntegrationRejected({
            reason: localized(m.integrations_error_cannot_sync),
          });
        // Incremental only with a cursor and a full listing within the day; a
        // selection edit clears the cursor, since newly picked pages need text.
        const since =
          source.cursor &&
          source.fullSyncedAt &&
          Date.now() - source.fullSyncedAt.getTime() < FULL_SYNC_EVERY_MS
            ? new Date(source.cursor.getTime() - CURSOR_OVERLAP_MS)
            : null;
        const listed = yield* adapter.enumerate(session, [source.root.nodeId], since);
        let cursor = source.cursor;
        for (const document of listed.documents)
          if (document.updatedAt && (!cursor || document.updatedAt > cursor))
            cursor = document.updatedAt;
        const remote = listed.documents.filter((document) => isSelected(document, [source.root]));
        const existing = yield* db
          .select({
            id: knowledgeDocuments.id,
            externalId: knowledgeDocuments.externalId,
            externalUpdatedAt: knowledgeDocuments.externalUpdatedAt,
          })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.sourceId, source.id))
          .pipe(Effect.orDie);
        const byExternal = new Map(existing.map((row) => [row.externalId, row]));
        // Pages another source of this collection already mirrors, so two
        // overlapping sources never index one page twice. Whoever had it
        // first keeps it; if that source lets go, this one takes it next time.
        const claimedElsewhere = new Set(
          (yield* db
            .select({ externalId: knowledgeDocuments.externalId })
            .from(knowledgeDocuments)
            .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId))
            .where(
              and(
                eq(knowledgeDocuments.collectionId, source.collectionId),
                eq(knowledgeSources.integrationId, source.integrationId),
                ne(knowledgeDocuments.sourceId, source.id),
              ),
            )
            .pipe(Effect.orDie)).map((row) => row.externalId),
        );
        // Room left in the collection: a page that could not be stored anyway
        // is counted, not downloaded, until space frees up.
        const [stored] = yield* db
          .select({ total: count() })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.collectionId, source.collectionId))
          .pipe(Effect.orDie);
        let room = KNOWLEDGE_LIMITS.maxDocumentsPerCollection - Number(stored?.total ?? 0);
        const oversized: Record<string, string> = {};
        const stats: KnowledgeSourceStats = {
          synced: 0,
          tooLarge: 0,
          overLimit: 0,
          elsewhere: 0,
        };
        const wanted = new Set<string>();
        for (const document of remote) {
          const current = byExternal.get(document.externalId);
          if (!current && claimedElsewhere.has(document.externalId)) {
            stats.elsewhere = (stats.elsewhere ?? 0) + 1;
            continue;
          }
          wanted.add(document.externalId);
          // Stored and not changed since: no text crosses the wire at all.
          if (
            current &&
            (document.updatedAt === null ||
              (current.externalUpdatedAt &&
                current.externalUpdatedAt.getTime() >= document.updatedAt.getTime()))
          ) {
            stats.synced++;
            continue;
          }
          if (!current) {
            const known = source.oversized[document.externalId];
            if (
              known &&
              (document.updatedAt === null || document.updatedAt.getTime() <= Date.parse(known))
            ) {
              oversized[document.externalId] = known;
              stats.tooLarge++;
              continue;
            }
            if (room <= 0) {
              stats.overLimit++;
              continue;
            }
          }
          // Not stored yet but not in the change listing (moved into the
          // selection, say): fetched on its own.
          const fetched =
            document.markdown === undefined || document.updatedAt === null
              ? yield* adapter.fetch(session, document.externalId)
              : null;
          const body = document.markdown ?? fetched?.markdown ?? "";
          const updatedAt = document.updatedAt ?? fetched?.updatedAt ?? new Date(0);
          const title =
            document.title.trim().slice(0, KNOWLEDGE_LIMITS.maxNameLength) || "Untitled";
          // An empty page still publishes something to find by its title.
          const content = body.trim() ? body : `# ${title}`;
          if (content.length > KNOWLEDGE_LIMITS.maxNoteChars) {
            if (!current) oversized[document.externalId] = updatedAt.toISOString();
            stats.tooLarge++;
            continue;
          }
          // The knowledge pipeline versions, dedupes and indexes it; an
          // unchanged body reuses the latest version.
          const saved = yield* knowledge.publishSourceNote(owner, {
            fence,
            ...(current ? { documentId: current.id } : {}),
            title,
            content,
            externalId: document.externalId,
            externalUrl: document.url,
            externalUpdatedAt: updatedAt,
          });
          if (!saved)
            return yield* new IntegrationRejected({
              reason: localized(m.integrations_error_source_changed),
            });
          if (!current) room--;
          stats.synced++;
        }
        // Deleted, archived or unpublished at the source, moved out of the
        // selection, or under a root that is gone: the index follows.
        for (const row of existing)
          if (row.externalId && !wanted.has(row.externalId))
            if (
              !(yield* knowledge.deleteSourceDocument(owner, fence, {
                documentId: row.id,
                externalId: row.externalId,
              }))
            )
              return yield* new IntegrationRejected({
                reason: localized(m.integrations_error_source_stale),
              });
        const gone = listed.missing.includes(source.root.nodeId) ? [source.root.title] : [];
        return { stats, gone, cursor, oversized, full: since === null };
      }).pipe(
        Effect.map((result) => ({ ok: true as const, ...result })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (outcome.ok)
        yield* finish({
          cursor: outcome.cursor,
          oversized: outcome.oversized,
          ...(outcome.full ? { fullSyncedAt: new Date() } : {}),
          ...(outcome.gone.length
            ? {
                status: "error",
                lastError: m.integrations_sync_gone(
                  { count: outcome.gone.length, titles: outcome.gone.join(", ") },
                  { locale: yield* languages.localeOf(owner) },
                ),
                stats: outcome.stats,
              }
            : { status: "idle" as const, lastError: null, stats: outcome.stats }),
        });
      else {
        if (outcome.error._tag === "IntegrationAuthFailed")
          yield* integrations.reportAuthFailure({ userId: owner, failure: outcome.error });
        yield* finish({
          status: "error",
          lastError: failureText(outcome.error)(yield* languages.localeOf(owner)),
        });
      }
      yield* changed;
    });

    const claim = db
      .transaction((tx) =>
        Effect.gen(function* () {
          const sibling = alias(knowledgeSources, "sibling");
          const candidates = yield* tx
            .select({ id: knowledgeSources.id, collectionId: knowledgeSources.collectionId })
            .from(knowledgeSources)
            .where(
              and(
                lte(knowledgeSources.nextSyncAt, sql`clock_timestamp()`),
                or(
                  isNull(knowledgeSources.leaseUntil),
                  lte(knowledgeSources.leaseUntil, sql`clock_timestamp()`),
                ),
                // One sync per collection at a time: overlapping sources decide
                // who keeps a shared page by what is already stored.
                notExists(
                  tx
                    .select({ id: sibling.id })
                    .from(sibling)
                    .where(
                      and(
                        eq(sibling.collectionId, knowledgeSources.collectionId),
                        ne(sibling.id, knowledgeSources.id),
                        sql`${sibling.leaseUntil} > clock_timestamp()`,
                      ),
                    ),
                ),
              ),
            )
            .orderBy(knowledgeSources.createdAt)
            .limit(BATCH);
          if (candidates.length === 0) return [];
          // Collection before source everywhere: claims serialize with source
          // edits, publication and removal, including across process copies.
          const collections = yield* tx
            .select({ id: knowledgeCollections.id })
            .from(knowledgeCollections)
            .where(
              inArray(knowledgeCollections.id, [
                ...new Set(candidates.map((row) => row.collectionId)),
              ]),
            )
            .orderBy(knowledgeCollections.id)
            .for("update", { skipLocked: true });
          const claimed: SourceRow[] = [];
          for (const collection of collections) {
            const candidate = candidates.find((row) => row.collectionId === collection.id)!;
            const [current] = yield* tx
              .select()
              .from(knowledgeSources)
              .where(
                and(
                  eq(knowledgeSources.id, candidate.id),
                  eq(knowledgeSources.collectionId, collection.id),
                ),
              )
              .for("update");
            if (!current) continue;
            const [due] = yield* tx
              .select({ id: knowledgeSources.id })
              .from(knowledgeSources)
              .where(
                and(
                  eq(knowledgeSources.id, current.id),
                  lte(knowledgeSources.nextSyncAt, sql`clock_timestamp()`),
                  or(
                    isNull(knowledgeSources.leaseUntil),
                    lte(knowledgeSources.leaseUntil, sql`clock_timestamp()`),
                  ),
                  notExists(
                    tx
                      .select({ id: sibling.id })
                      .from(sibling)
                      .where(
                        and(
                          eq(sibling.collectionId, collection.id),
                          ne(sibling.id, current.id),
                          sql`${sibling.leaseUntil} > clock_timestamp()`,
                        ),
                      ),
                  ),
                ),
              );
            if (!due) continue;
            const [row] = yield* tx
              .update(knowledgeSources)
              .set({
                status: "syncing",
                leaseToken: uuidv7(),
                leaseUntil: leaseFor(LEASE_SECONDS),
                nextSyncAt: sql`clock_timestamp() + ${SYNC_EVERY}::interval`,
              })
              .where(eq(knowledgeSources.id, current.id))
              .returning();
            if (row) claimed.push(row);
          }
          return claimed;
        }),
      )
      .pipe(Effect.orDie);

    // Claims take turns: "one source per collection" is checked against
    // committed leases, which two concurrent claims (the timer and a save's
    // kick) cannot see of each other.
    const claimTurn = yield* Semaphore.make(1);
    // Claimed sources sync side by side and the pass waits for them.
    const tick: Effect.Effect<void> = Effect.gen(function* () {
      const claimed = yield* claimTurn.withPermits(1)(claim);
      if (claimed.length) yield* changed;
      yield* Effect.forEach(
        claimed,
        (source) =>
          run(source).pipe(
            Effect.catchCause((cause) => Effect.logError("knowledge source sync failed", cause)),
          ),
        { concurrency: "unbounded", discard: true },
      );
    });
    const kick = background ? Effect.forkDetach(tick).pipe(Effect.asVoid) : Effect.void;

    if (background)
      yield* tick.pipe(
        Effect.catchCause((cause) => Effect.logError("knowledge source tick failed", cause)),
        Effect.repeat(EffectSchedule.spaced(TICK_INTERVAL)),
        Effect.forkScoped,
      );

    const ownedSource = (userId: string, sourceId: string) =>
      db
        .select({ source: knowledgeSources })
        .from(knowledgeSources)
        .innerJoin(knowledgeCollections, eq(knowledgeCollections.id, knowledgeSources.collectionId))
        .where(
          and(
            eq(knowledgeSources.id, sourceId),
            eq(knowledgeCollections.userId, userId),
            capabilityAllowedSql(userId, "knowledgeCreate"),
          ),
        )
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows[0]?.source ?? null),
        );

    return KnowledgeSourceService.of({
      list,

      save: Effect.fn("KnowledgeSourceService.save")(function* (userId, input) {
        if (!(yield* ownedCollection(userId, input.collectionId)))
          return yield* new IntegrationRejected({
            reason: localized(m.integrations_error_owner_only),
          });
        // Saving needs a working account of theirs now; later syncs look it up again.
        const session = yield* integrations.session(userId, input.connectionId);
        if (!findIntegrationType(session.integration.kind)?.knowledgeSource)
          return yield* new IntegrationRejected({
            reason: localized(m.integrations_error_cannot_sync),
          });
        const integrationId = session.integration.id;
        const root = { ...input.root, rules: [...input.root.rules] };
        const row = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [collection] = yield* tx
                .select({ id: knowledgeCollections.id })
                .from(knowledgeCollections)
                .where(
                  and(
                    eq(knowledgeCollections.id, input.collectionId),
                    eq(knowledgeCollections.userId, userId),
                  ),
                )
                .for("update");
              if (!collection) return null;
              const [saved] = input.sourceId
                ? yield* tx
                    .update(knowledgeSources)
                    .set({
                      root,
                      connectionId: input.connectionId,
                      // A new selection revokes the old worker and starts in full.
                      cursor: null,
                      leaseToken: null,
                      leaseUntil: null,
                      status: "idle",
                      // Database clock, like the claim that compares against it.
                      nextSyncAt: sql`now()`,
                      lastError: null,
                      updatedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(knowledgeSources.id, input.sourceId),
                        eq(knowledgeSources.collectionId, input.collectionId),
                        // Another account of the same integration, never another integration.
                        eq(knowledgeSources.integrationId, integrationId),
                      ),
                    )
                    .returning()
                    .pipe(Effect.orDie)
                : yield* tx
                    .insert(knowledgeSources)
                    .values({
                      id: uuidv7(),
                      collectionId: input.collectionId,
                      integrationId,
                      connectionId: input.connectionId,
                      root,
                      nextSyncAt: sql`now()`,
                    })
                    .returning()
                    .pipe(Effect.orDie);
              return saved ?? null;
            }),
          )
          .pipe(Effect.orDie);
        if (!row)
          return yield* new IntegrationRejected({
            reason: localized(m.integrations_error_source_gone),
          });
        yield* kick;
        return toView(row, true, true, session.account);
      }),

      remove: Effect.fn("KnowledgeSourceService.remove")(function* (userId, sourceId) {
        const removed = yield* knowledge.removeSource(userId, sourceId);
        if (removed) yield* changed;
        return removed;
      }),

      syncNow: Effect.fn("KnowledgeSourceService.syncNow")(function* (userId, sourceId) {
        const source = yield* ownedSource(userId, sourceId);
        if (!source) return false;
        yield* db
          .update(knowledgeSources)
          .set({ nextSyncAt: sql`now()` })
          .where(eq(knowledgeSources.id, sourceId))
          .pipe(Effect.orDie);
        yield* kick;
        return true;
      }),

      browse: Effect.fn("KnowledgeSourceService.browse")(
        function* (userId, connectionId, parentId) {
          const session = yield* integrations.session(userId, connectionId);
          const adapter = session.adapter.knowledge;
          if (!adapter)
            return yield* new IntegrationRejected({
              reason: localized(m.integrations_error_cannot_sync),
            });
          return yield* adapter
            .browse(session, parentId)
            .pipe(
              Effect.catch((error: AdapterFailure) =>
                Effect.fail(new IntegrationRejected({ reason: failureText(error) })),
              ),
            );
        },
      ),

      tick,
    });
  });
}
