import { and, asc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  agents,
  agentUserGrants,
  agentGroupGrants,
  knowledgeCollections,
  knowledgeCollectionUserGrants,
  knowledgeCollectionGroupGrants,
  groups,
  groupMembers,
  user,
} from "~/db/schema/index.ts";
import { KnowledgeNotAvailable, SharingNotAllowed } from "~/modules/knowledge/errors.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { SharingRateLimited } from "../errors.ts";
import type { ResourceGrants, SharedResource, ShareRecipient } from "../schema.ts";

const escapeLike = (text: string): string => text.replaceAll(/[\\%_]/g, "\\$&");
/** One page of the picker; the query narrows it rather than paging. */
const RECIPIENT_LIMIT = 20;

type SharingError = KnowledgeNotAvailable | SharingNotAllowed;
type Change =
  | { action: "email"; email: string }
  | { action: "group"; groupId: string }
  | { action: "revokeUser"; userId: string }
  | { action: "revokeGroup"; groupId: string }
  | { action: "publish"; audience: "private" | "instance" };

/** Shared policy, separate FK-backed grant tables for the two resource types. */
export class SharingService extends Context.Service<
  SharingService,
  {
    detail(
      userId: string,
      resource: SharedResource,
    ): Effect.Effect<ResourceGrants, KnowledgeNotAvailable>;
    change(
      userId: string,
      resource: SharedResource,
      change: Change,
    ): Effect.Effect<void, SharingError | SharingRateLimited>;
    recipients(userId: string, q: string): Effect.Effect<ReadonlyArray<ShareRecipient>>;
  }
>()("chat/sharing/SharingService") {
  static readonly layer = Layer.effect(
    SharingService,
    Effect.gen(function* () {
      const db = yield* Db;
      const bus = yield* SyncBus;
      // Per-runtime throttle on grant-by-email, bounded even for many accounts.
      // `recipients` deliberately exposes an account directory to any signed-in
      // user — this is a single-tenant, self-hosted app where colleagues pick
      // each other by name — so the throttle is a cap on automated granting,
      // not the enumeration defence it originally was.
      const lookups = new Map<string, { until: number; count: number }>();
      const admitLookup = (userId: string) =>
        Effect.suspend(() => {
          const now = Date.now();
          for (const [id, window] of lookups) if (window.until <= now) lookups.delete(id);
          const current = lookups.get(userId);
          if ((current?.count ?? 0) >= 10 || (!current && lookups.size >= 10_000))
            return Effect.fail(new SharingRateLimited());
          lookups.set(userId, {
            until: current?.until ?? now + 60_000,
            count: (current?.count ?? 0) + 1,
          });
          return Effect.void;
        });
      const owned = (userId: string, resource: SharedResource) =>
        resource.kind === "agent"
          ? db
              .select({ audience: agents.audience })
              .from(agents)
              .where(and(eq(agents.id, resource.id), eq(agents.userId, userId)))
          : db
              .select({ audience: knowledgeCollections.audience })
              .from(knowledgeCollections)
              .where(
                and(
                  eq(knowledgeCollections.id, resource.id),
                  eq(knowledgeCollections.userId, userId),
                ),
              );
      return SharingService.of({
        detail: Effect.fn("SharingService.detail")(function* (userId, resource) {
          const [owner] = yield* owned(userId, resource).pipe(Effect.orDie);
          if (!owner) return yield* new KnowledgeNotAvailable({ resourceId: resource.id });
          const [actor] = yield* db
            .select({ role: user.role })
            .from(user)
            .where(eq(user.id, userId))
            .pipe(Effect.orDie);
          const canPublish = actor?.role === "admin";
          const users = yield* (
            resource.kind === "agent"
              ? db
                  .select({ userId: user.id, name: user.name, email: user.email })
                  .from(agentUserGrants)
                  .innerJoin(user, eq(user.id, agentUserGrants.userId))
                  .where(eq(agentUserGrants.agentId, resource.id))
                  .orderBy(asc(user.name))
              : db
                  .select({ userId: user.id, name: user.name, email: user.email })
                  .from(knowledgeCollectionUserGrants)
                  .innerJoin(user, eq(user.id, knowledgeCollectionUserGrants.userId))
                  .where(eq(knowledgeCollectionUserGrants.collectionId, resource.id))
                  .orderBy(asc(user.name))
          ).pipe(Effect.orDie);
          const granted = yield* (
            resource.kind === "agent"
              ? db
                  .select({ groupId: groups.id, name: groups.name })
                  .from(agentGroupGrants)
                  .innerJoin(groups, eq(groups.id, agentGroupGrants.groupId))
                  .where(eq(agentGroupGrants.agentId, resource.id))
                  .orderBy(asc(groups.name))
              : db
                  .select({ groupId: groups.id, name: groups.name })
                  .from(knowledgeCollectionGroupGrants)
                  .innerJoin(groups, eq(groups.id, knowledgeCollectionGroupGrants.groupId))
                  .where(eq(knowledgeCollectionGroupGrants.collectionId, resource.id))
                  .orderBy(asc(groups.name))
          ).pipe(Effect.orDie);
          const eligibleGroups = yield* db
            .select({ id: groups.id, name: groups.name })
            .from(groups)
            .where(
              canPublish
                ? undefined
                : sql`exists(select 1 from ${groupMembers} where ${groupMembers.groupId} = ${groups.id} and ${groupMembers.userId} = ${userId} and ${groupMembers.canShare} = true)`,
            )
            .orderBy(asc(groups.name))
            .limit(200)
            .pipe(Effect.orDie);
          if ((yield* owned(userId, resource).pipe(Effect.orDie)).length === 0)
            return yield* new KnowledgeNotAvailable({ resourceId: resource.id });
          return { audience: owner.audience, canPublish, users, groups: granted, eligibleGroups };
        }),
        // Names and email addresses of other accounts, for the sharing picker.
        // Every signed-in user may read this; nothing else about an account is
        // exposed, and it never reveals who already has access to what.
        recipients: Effect.fn("SharingService.recipients")(function* (userId, q) {
          const needle = escapeLike(q.trim());
          return yield* db
            .select({ userId: user.id, name: user.name, email: user.email })
            .from(user)
            .where(
              and(
                ne(user.id, userId),
                needle
                  ? or(ilike(user.name, `%${needle}%`), ilike(user.email, `%${needle}%`))
                  : undefined,
              ),
            )
            .orderBy(asc(user.name))
            .limit(RECIPIENT_LIMIT)
            .pipe(Effect.orDie);
        }),
        change: Effect.fn("SharingService.change")(function* (userId, resource, change) {
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [actor] = yield* tx
                  .select({ role: user.role })
                  .from(user)
                  .where(eq(user.id, userId))
                  .for("share");
                const rows = yield* resource.kind === "agent"
                  ? tx
                      .select({ id: agents.id })
                      .from(agents)
                      .where(and(eq(agents.id, resource.id), eq(agents.userId, userId)))
                      .for("update")
                  : tx
                      .select({ id: knowledgeCollections.id })
                      .from(knowledgeCollections)
                      .where(
                        and(
                          eq(knowledgeCollections.id, resource.id),
                          eq(knowledgeCollections.userId, userId),
                        ),
                      )
                      .for("update");
                if (!actor || rows.length === 0)
                  return yield* new KnowledgeNotAvailable({ resourceId: resource.id });
                switch (change.action) {
                  case "email": {
                    yield* admitLookup(userId);
                    const email = change.email.trim().toLowerCase();
                    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
                      return yield* new SharingNotAllowed({
                        reason: "enter an existing account's email address",
                      });
                    const [recipient] = yield* tx
                      .select({ id: user.id })
                      .from(user)
                      .where(eq(user.email, email))
                      .for("key share");
                    if (!recipient || recipient.id === userId)
                      return yield* new SharingNotAllowed({
                        reason: "could not share with that account",
                      });
                    const [count] = yield* resource.kind === "agent"
                      ? tx
                          .select({
                            value: sql<number>`count(*)::int`,
                            existing: sql<boolean>`coalesce(bool_or(${agentUserGrants.userId} = ${recipient.id}), false)`,
                          })
                          .from(agentUserGrants)
                          .where(eq(agentUserGrants.agentId, resource.id))
                      : tx
                          .select({
                            value: sql<number>`count(*)::int`,
                            existing: sql<boolean>`coalesce(bool_or(${knowledgeCollectionUserGrants.userId} = ${recipient.id}), false)`,
                          })
                          .from(knowledgeCollectionUserGrants)
                          .where(eq(knowledgeCollectionUserGrants.collectionId, resource.id));
                    if (count?.existing) break;
                    if ((count?.value ?? 0) >= 100)
                      return yield* new SharingNotAllowed({
                        reason: "direct sharing limit reached",
                      });
                    if (resource.kind === "agent")
                      yield* tx
                        .insert(agentUserGrants)
                        .values({ agentId: resource.id, userId: recipient.id })
                        .onConflictDoNothing();
                    else
                      yield* tx
                        .insert(knowledgeCollectionUserGrants)
                        .values({ collectionId: resource.id, userId: recipient.id })
                        .onConflictDoNothing();
                    break;
                  }
                  case "group": {
                    const [count] = yield* resource.kind === "agent"
                      ? tx
                          .select({
                            value: sql<number>`count(*)::int`,
                            existing: sql<boolean>`coalesce(bool_or(${agentGroupGrants.groupId} = ${change.groupId}), false)`,
                          })
                          .from(agentGroupGrants)
                          .where(eq(agentGroupGrants.agentId, resource.id))
                      : tx
                          .select({
                            value: sql<number>`count(*)::int`,
                            existing: sql<boolean>`coalesce(bool_or(${knowledgeCollectionGroupGrants.groupId} = ${change.groupId}), false)`,
                          })
                          .from(knowledgeCollectionGroupGrants)
                          .where(eq(knowledgeCollectionGroupGrants.collectionId, resource.id));
                    // Policy controls new grants, not an idempotent repeat of an
                    // existing one after the member loses sharing permission.
                    if (count?.existing) break;
                    if ((count?.value ?? 0) >= 100)
                      return yield* new SharingNotAllowed({
                        reason: "group sharing limit reached",
                      });
                    const [group] = yield* tx
                      .select()
                      .from(groups)
                      .where(eq(groups.id, change.groupId))
                      .for("share");
                    if (!group)
                      return yield* new SharingNotAllowed({
                        reason: "group is not available for sharing",
                      });
                    if (actor.role !== "admin") {
                      // Held through insertion: permission updates and membership deletion
                      // must serialize with this authorization decision.
                      const [member] = yield* tx
                        .select({ canShare: groupMembers.canShare })
                        .from(groupMembers)
                        .where(
                          and(
                            eq(groupMembers.groupId, change.groupId),
                            eq(groupMembers.userId, userId),
                          ),
                        )
                        .for("share");
                      if (!member?.canShare)
                        return yield* new SharingNotAllowed({
                          reason: "group is not available for sharing",
                        });
                    }
                    if (resource.kind === "agent")
                      yield* tx
                        .insert(agentGroupGrants)
                        .values({ agentId: resource.id, groupId: change.groupId })
                        .onConflictDoNothing();
                    else
                      yield* tx
                        .insert(knowledgeCollectionGroupGrants)
                        .values({ collectionId: resource.id, groupId: change.groupId })
                        .onConflictDoNothing();
                    break;
                  }
                  case "revokeUser":
                    if (resource.kind === "agent")
                      yield* tx
                        .delete(agentUserGrants)
                        .where(
                          and(
                            eq(agentUserGrants.agentId, resource.id),
                            eq(agentUserGrants.userId, change.userId),
                          ),
                        );
                    else
                      yield* tx
                        .delete(knowledgeCollectionUserGrants)
                        .where(
                          and(
                            eq(knowledgeCollectionUserGrants.collectionId, resource.id),
                            eq(knowledgeCollectionUserGrants.userId, change.userId),
                          ),
                        );
                    break;
                  case "revokeGroup":
                    if (resource.kind === "agent")
                      yield* tx
                        .delete(agentGroupGrants)
                        .where(
                          and(
                            eq(agentGroupGrants.agentId, resource.id),
                            eq(agentGroupGrants.groupId, change.groupId),
                          ),
                        );
                    else
                      yield* tx
                        .delete(knowledgeCollectionGroupGrants)
                        .where(
                          and(
                            eq(knowledgeCollectionGroupGrants.collectionId, resource.id),
                            eq(knowledgeCollectionGroupGrants.groupId, change.groupId),
                          ),
                        );
                    break;
                  case "publish":
                    // Publication is still an owner sharing action, with an additional
                    // admin gate. Admin status alone never exposes a private resource.
                    if (actor.role !== "admin")
                      return yield* new SharingNotAllowed({
                        reason: "only admin owners can publish to the instance",
                      });
                    if (resource.kind === "agent")
                      yield* tx
                        .update(agents)
                        .set({ audience: change.audience, updatedAt: new Date() })
                        .where(eq(agents.id, resource.id));
                    else
                      yield* tx
                        .update(knowledgeCollections)
                        .set({ audience: change.audience, updatedAt: new Date() })
                        .where(eq(knowledgeCollections.id, resource.id));
                }
              }),
            )
            .pipe(
              Effect.catchTag("EffectDrizzleQueryError", Effect.die),
              Effect.catchTag("SqlError", Effect.die),
            );
          yield* bus
            .publishGlobal({ type: "resources.changed" })
            .pipe(
              Effect.catchCause(() => Effect.logWarning("sharing resource invalidation failed")),
            );
        }),
      });
    }),
  );
}
