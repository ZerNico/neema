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
import { defaultCapabilities, groupMembers, groups, user } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";
import {
  ALL_CAPABILITIES,
  CAPABILITY_KEYS,
  effectiveCapabilities,
  type Capabilities,
  type Capability,
} from "../policy.ts";
export type { Capability, Capabilities } from "../policy.ts";

const NO_CAPABILITIES = Object.fromEntries(
  CAPABILITY_KEYS.map((key) => [key, false]),
) as Capabilities;

/** SQL condition for resource owners and other correlated access checks. */
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
  const keys: Capability[] =
    key === "agentsUse"
      ? [key, "agentsCreate"]
      : key === "knowledgeUse"
        ? [key, "knowledgeCreate"]
        : key === "skillsUse"
          ? [key, "skillsCreate"]
          : [key];
  const allowed = (column: SQL) =>
    sql`(${column} ->> ${keys[0]})::boolean${
      keys[1] ? sql` or (${column} ->> ${keys[1]})::boolean` : sql``
    }`;
  return sql<boolean>`exists (
    select 1 from "user" as policy_actor
    where policy_actor.id = ${actorId}
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
      const forUser = Effect.fn("FeaturePolicy.forUser")(function* (userId: string, tx?: DbTx) {
        const rows = yield* (tx ?? db)
          .select({
            role: user.role,
            capabilities: groups.capabilities,
            defaults: defaultCapabilities.capabilities,
          })
          .from(user)
          .innerJoin(defaultCapabilities, eq(defaultCapabilities.id, 1))
          .leftJoin(groupMembers, eq(groupMembers.userId, user.id))
          .leftJoin(groups, eq(groups.id, groupMembers.groupId))
          .where(eq(user.id, userId))
          .pipe(Effect.orDie);
        if (!rows.length) return NO_CAPABILITIES;
        if (rows[0]!.role === "admin") return ALL_CAPABILITIES;
        if (!rows[0]!.capabilities) return effectiveCapabilities(rows[0]!.defaults);
        const result = { ...NO_CAPABILITIES };
        for (const row of rows) {
          if (!row.capabilities) continue;
          for (const key of CAPABILITY_KEYS) result[key] ||= row.capabilities[key];
        }
        return effectiveCapabilities(result);
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
