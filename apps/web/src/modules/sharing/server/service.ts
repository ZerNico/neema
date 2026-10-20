import { addressableByEmailSql } from "~/modules/auth/server/account-eligibility.ts";
import { and, asc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { groups, groupMembers, user } from "~/db/schema/index.ts";
import { KnowledgeNotAvailable, SharingNotAllowed } from "~/modules/knowledge/errors.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import type { Capability } from "~/modules/groups/policy.ts";
import { SharingRateLimited } from "../errors.ts";
import { sharingResources } from "./resources.ts";
import type { ResourceGrants, SharedResource, ShareRecipient } from "../schema.ts";
import { escapeLike } from "~/server/sql.ts";

/** One page of the picker; the query narrows it rather than paging. */
const RECIPIENT_LIMIT = 20;

type SharingError = KnowledgeNotAvailable | SharingNotAllowed;
type Change =
  | { action: "email"; email: string }
  | { action: "group"; groupId: string }
  | { action: "revokeUser"; userId: string }
  | { action: "revokeGroup"; groupId: string }
  | { action: "publish"; audience: "private" | "instance" };

// Custom tools are admin-only, so no member column can let one be shared.
const shareColumn = (kind: SharedResource["kind"]) =>
  kind === "agent"
    ? groupMembers.shareAgents
    : kind === "collection"
      ? groupMembers.shareKnowledge
      : kind === "skill"
        ? groupMembers.shareSkills
        : null;

/** Shared policy, separate FK-backed grant tables for each resource type. */
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
      const policy = yield* FeaturePolicy;
      const bus = yield* SyncBus;
      // Custom tools and integrations are admin-managed; no member capability applies.
      const createCapability: Record<SharedResource["kind"], Capability | null> = {
        agent: "agentsCreate",
        collection: "knowledgeCreate",
        skill: "skillsCreate",
        customTool: null,
        integration: null,
      };
      const mayManage = (userId: string, resource: SharedResource) =>
        Effect.suspend(() => {
          const capability = createCapability[resource.kind];
          return capability ? policy.can(userId, capability) : Effect.succeed(true);
        });
      // Per-runtime throttle on grant-by-email, bounded even for many accounts.
      // `recipients` deliberately exposes an account directory to any signed-in
      // user, since this is a single-tenant, self-hosted app where colleagues pick
      // each other by name, so the throttle is a cap on automated granting,
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
      const owned = (userId: string, resource: SharedResource) => {
        const { table, available, managedBy } = sharingResources[resource.kind];
        return db
          .select({ audience: table.audience })
          .from(table)
          .where(and(eq(table.id, resource.id), managedBy(userId), available));
      };
      return SharingService.of({
        detail: Effect.fn("SharingService.detail")(function* (userId, resource) {
          if (!(yield* mayManage(userId, resource)))
            return yield* new KnowledgeNotAvailable({ resourceId: resource.id });
          const [owner] = yield* owned(userId, resource).pipe(Effect.orDie);
          if (!owner) return yield* new KnowledgeNotAvailable({ resourceId: resource.id });
          const [actor] = yield* db
            .select({ role: user.role })
            .from(user)
            .where(eq(user.id, userId))
            .pipe(Effect.orDie);
          const canPublish = actor?.role === "admin";
          const descriptor = sharingResources[resource.kind];
          const users = yield* db
            .select({ userId: user.id, name: user.name, email: user.email })
            .from(descriptor.userGrants)
            .innerJoin(user, eq(user.id, descriptor.userGrants.userId))
            .where(eq(descriptor.userResourceId, resource.id))
            .orderBy(asc(user.name))
            .pipe(Effect.orDie);
          const granted = yield* db
            .select({ groupId: groups.id, name: groups.name })
            .from(descriptor.groupGrants)
            .innerJoin(groups, eq(groups.id, descriptor.groupGrants.groupId))
            .where(eq(descriptor.groupResourceId, resource.id))
            .orderBy(asc(groups.name))
            .pipe(Effect.orDie);
          const eligibleGroups = yield* db
            .select({ id: groups.id, name: groups.name })
            .from(groups)
            .where(
              canPublish
                ? undefined
                : sql`exists(select 1 from ${groupMembers} where ${groupMembers.groupId} = ${groups.id} and ${groupMembers.userId} = ${userId} and ${shareColumn(resource.kind) ?? sql`false`} = true)`,
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
                // The picker shares by address, so it offers only addresses a share can reach.
                addressableByEmailSql,
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
          if (!(yield* mayManage(userId, resource)))
            return yield* new KnowledgeNotAvailable({ resourceId: resource.id });
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const capability = createCapability[resource.kind];
                if (capability && !(yield* policy.can(userId, capability, tx)))
                  return yield* new KnowledgeNotAvailable({ resourceId: resource.id });
                const [actor] = yield* tx
                  .select({ role: user.role })
                  .from(user)
                  .where(eq(user.id, userId))
                  .for("share");
                const descriptor = sharingResources[resource.kind];
                const { table, userGrants, userResourceId, groupGrants, groupResourceId } =
                  descriptor;
                const rows = yield* tx
                  .select({ id: table.id })
                  .from(table)
                  .where(
                    and(
                      eq(table.id, resource.id),
                      descriptor.managedBy(userId),
                      descriptor.available,
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
                      .where(and(eq(user.email, email), addressableByEmailSql))
                      .for("key share");
                    if (!recipient || recipient.id === userId)
                      return yield* new SharingNotAllowed({
                        reason: "could not share with that account",
                      });
                    const [count] = yield* tx
                      .select({
                        value: sql<number>`count(*)::int`,
                        existing: sql<boolean>`coalesce(bool_or(${userGrants.userId} = ${recipient.id}), false)`,
                      })
                      .from(userGrants)
                      .where(eq(userResourceId, resource.id));
                    if (count?.existing) break;
                    if ((count?.value ?? 0) >= 100)
                      return yield* new SharingNotAllowed({
                        reason: "direct sharing limit reached",
                      });
                    yield* tx.execute(
                      sql`insert into ${userGrants} (${sql.identifier(userResourceId.name)}, user_id) values (${resource.id}, ${recipient.id}) on conflict do nothing`,
                    );
                    break;
                  }
                  case "group": {
                    const [count] = yield* tx
                      .select({
                        value: sql<number>`count(*)::int`,
                        existing: sql<boolean>`coalesce(bool_or(${groupGrants.groupId} = ${change.groupId}), false)`,
                      })
                      .from(groupGrants)
                      .where(eq(groupResourceId, resource.id));
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
                      const column = shareColumn(resource.kind);
                      const [member] = yield* tx
                        .select({ canShare: column ?? sql<boolean>`false` })
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
                    yield* tx.execute(
                      sql`insert into ${groupGrants} (${sql.identifier(groupResourceId.name)}, group_id) values (${resource.id}, ${change.groupId}) on conflict do nothing`,
                    );
                    break;
                  }
                  case "revokeUser":
                    yield* tx
                      .delete(userGrants)
                      .where(
                        and(eq(userResourceId, resource.id), eq(userGrants.userId, change.userId)),
                      );
                    break;
                  case "revokeGroup":
                    yield* tx
                      .delete(groupGrants)
                      .where(
                        and(
                          eq(groupResourceId, resource.id),
                          eq(groupGrants.groupId, change.groupId),
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
                    yield* tx
                      .update(table)
                      .set({ audience: change.audience, updatedAt: new Date() })
                      .where(eq(table.id, resource.id));
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
