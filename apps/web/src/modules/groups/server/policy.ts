import {
  Column,
  eq,
  getColumnTable,
  getTableName,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { user } from "~/db/schema/index.ts";
import { activeAccountOf } from "~/modules/auth/server/account-eligibility.ts";
import { Db, type DbTx } from "~/server/db.ts";
import { CAPABILITY_KEYS, type Capabilities, type Capability } from "../policy.ts";
export type { Capability, Capabilities } from "../policy.ts";

const NO_CAPABILITIES = Object.fromEntries(
  CAPABILITY_KEYS.map((key) => [key, false]),
) as Capabilities;

/**
 * SQL condition for resource owners and other correlated access checks. Given
 * the owner as a column, it also requires the owner's account to be active.
 */
export function capabilityAllowedSql(
  userId: string | SQL | AnyColumn,
  key: Capability,
): SQL<boolean> {
  // Selected SQL expressions de-qualify Drizzle columns. Preserve the table
  // name here so a correlated predicate never binds the inner policy_actor.id.
  const actorId =
    userId instanceof Column
      ? sql`${sql.identifier(getTableName(getColumnTable(userId)))}.${sql.identifier(userId.name)}`
      : userId;
  const allowed = (column: SQL) => sql`(${column} ->> ${key})::boolean`;
  // An owner's shared work stays usable only while they could use the app
  // themselves: a ban or a reversed approval suspends it, as losing Create does.
  const ownerActive =
    userId instanceof Column ? sql` and ${activeAccountOf("policy_actor")}` : sql``;
  return sql<boolean>`exists (
    select 1 from "user" as policy_actor
    where policy_actor.id = ${actorId}${ownerActive}
      and (
        policy_actor.role = 'admin'
        or exists (
          select 1 from group_members as policy_member
          join groups as policy_group on policy_group.id = policy_member.group_id
          where policy_member.user_id = policy_actor.id
            and (${allowed(sql`policy_group.capabilities`)})
        )
        or (
          not exists (select 1 from group_members as policy_member where policy_member.user_id = policy_actor.id)
          and exists (
            select 1 from default_capabilities as policy_default
            where policy_default.id = 1
              and (${allowed(sql`policy_default.capabilities`)})
          )
        )
      )
  )`;
}

export class CapabilityDenied extends Error {
  constructor(readonly key: Capability) {
    super(`Capability not allowed: ${key}`);
  }
}

export class FeaturePolicy extends Context.Service<
  FeaturePolicy,
  {
    forUser(userId: string, tx?: DbTx): Effect.Effect<Capabilities>;
    can(userId: string, key: Capability, tx?: DbTx): Effect.Effect<boolean>;
    require(userId: string, key: Capability, tx?: DbTx): Effect.Effect<void, CapabilityDenied>;
  }
>()("chat/groups/FeaturePolicy") {
  static readonly layer = Layer.effect(
    FeaturePolicy,
    Effect.gen(function* () {
      const db = yield* Db;
      // Every key through `capabilityAllowedSql`, in one query, so the list
      // and each single check can never disagree.
      const forUser = Effect.fn("FeaturePolicy.forUser")(function* (userId: string, tx?: DbTx) {
        const [row] = yield* (tx ?? db)
          .select(
            Object.fromEntries(
              CAPABILITY_KEYS.map((key) => [key, capabilityAllowedSql(userId, key)]),
            ),
          )
          .from(user)
          .where(eq(user.id, userId))
          .pipe(Effect.orDie);
        if (!row) return NO_CAPABILITIES;
        const result = { ...NO_CAPABILITIES };
        for (const key of CAPABILITY_KEYS) result[key] = row[key] === true;
        return result;
      });
      const can = Effect.fn("FeaturePolicy.can")(function* (
        userId: string,
        key: Capability,
        tx?: DbTx,
      ) {
        const [row] = yield* (tx ?? db)
          .select({ allowed: capabilityAllowedSql(userId, key) })
          .from(user)
          .where(eq(user.id, userId))
          .pipe(Effect.orDie);
        return Boolean(row?.allowed);
      });
      return FeaturePolicy.of({
        forUser,
        can,
        require: Effect.fn("FeaturePolicy.require")(function* (userId, key, tx) {
          if (!(yield* can(userId, key, tx))) return yield* Effect.fail(new CapabilityDenied(key));
        }),
      });
    }),
  );
}
