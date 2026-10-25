import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  groupMembers,
  groups,
  limitSettings,
  models,
  usageEvents,
  usageLimitModels,
  usageLimits,
  user,
} from "~/db/schema/index.ts";
import { isValidTimezone } from "~/modules/schedules/server/cron.ts";
import { Db, type DbTx } from "~/server/db.ts";
import { localized, type Localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";
import { LimitRejected, UsageLimitReached } from "../errors.ts";
import {
  coversModel,
  effectiveLimits,
  formatAmount,
  limitKey,
  type EffectiveLimit,
  type LimitMetric,
  type LimitPeriod,
  type LimitRule,
  type LimitStanding,
} from "../rules.ts";
export type { LimitStanding } from "../rules.ts";

export interface SaveLimitInput {
  readonly id: string | null;
  readonly groupId: string | null;
  readonly metric: LimitMetric;
  readonly period: LimitPeriod;
  readonly amount: number | null;
  readonly modelIds: ReadonlyArray<string> | null;
}

const MAX_AMOUNT = 1_000_000;

/** Where the current period began and when it ends, by the database clock in the instance's zone. */
const periodBounds = (period: LimitPeriod, timeZone: string) => {
  const local = sql`date_trunc(${period}, now() at time zone ${timeZone})`;
  return {
    start: sql`(${local} at time zone ${timeZone})`,
    resets: sql`((${local} + ${`1 ${period}`}::interval) at time zone ${timeZone})`,
  };
};

/** When the limit opens again, as its own sentence. */
const resetWords = (period: LimitPeriod, resetsAt: Date, timeZone: string, locale: Locale) => {
  if (period === "day") return m.limits_resets_midnight({ zone: timeZone }, { locale });
  // English reads "Monday 3 March" rather than the US order.
  const day = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, {
    timeZone,
    weekday: period === "week" ? "long" : undefined,
    day: "numeric",
    month: "long",
  }).format(resetsAt);
  return m.limits_resets_on({ day }, { locale });
};

/** Why an answer was refused, naming the limit and when it opens again. */
const reachedReason =
  (
    limit: EffectiveLimit,
    names: ReadonlyMap<string, string>,
    resetsAt: Date,
    zone: string,
  ): Localized =>
  (locale) => {
    const amount = formatAmount(limit.metric, limit.amount, locale);
    const reached =
      limit.modelIds === null
        ? m.limits_reached({ period: limit.period, amount }, { locale })
        : m.limits_reached_models(
            {
              period: limit.period,
              amount,
              models: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                limit.modelIds.map((id) => names.get(id) ?? m.limits_this_model({}, { locale })),
              ),
            },
            { locale },
          );
    return `${reached} ${resetWords(limit.period, resetsAt, zone, locale)}`;
  };

/**
 * Usage limits for everyone and for groups, held at the start of every
 * answer. Usage is read from the ledger, so a running answer counts once it
 * settles and never stops halfway. See `docs/internals/limits.md`.
 */
export class UsageLimits extends Context.Service<
  UsageLimits,
  {
    /** The limits this person is held to now; none for an admin. */
    limitsFor(userId: string, tx?: DbTx): Effect.Effect<EffectiveLimit[]>;
    /** Refuses an answer with this model once any limit covering it is used up. */
    check(userId: string, modelId: string, tx?: DbTx): Effect.Effect<void, UsageLimitReached>;
    /** Every limit the person is held to, with its use, for Settings and the model picker. */
    standing(userId: string): Effect.Effect<LimitStanding[]>;
    rules(): Effect.Effect<LimitRule[]>;
    saveRule(input: SaveLimitInput): Effect.Effect<LimitRule, LimitRejected>;
    deleteRule(id: string): Effect.Effect<void>;
    timeZone(tx?: DbTx): Effect.Effect<string>;
    setTimeZone(timeZone: string): Effect.Effect<void, LimitRejected>;
  }
>()("chat/limits/UsageLimits") {
  static readonly layer = Layer.effect(
    UsageLimits,
    Effect.gen(function* () {
      const db = yield* Db;

      const loadRules = Effect.fn("UsageLimits.loadRules")(function* (
        where: SQL | undefined,
        tx?: DbTx,
      ) {
        const q = tx ?? db;
        const rows = yield* q
          .select()
          .from(usageLimits)
          .where(where)
          .orderBy(usageLimits.createdAt)
          .pipe(Effect.orDie);
        if (!rows.length) return [];
        const picked = yield* q
          .select()
          .from(usageLimitModels)
          .where(
            inArray(
              usageLimitModels.limitId,
              rows.map((row) => row.id),
            ),
          )
          .pipe(Effect.orDie);
        return rows.map((row): LimitRule => ({
          id: row.id,
          groupId: row.groupId,
          metric: row.metric,
          period: row.period,
          amount: row.amount,
          modelIds: row.allModels
            ? null
            : picked.filter((entry) => entry.limitId === row.id).map((entry) => entry.modelId),
        }));
      });

      const timeZone = Effect.fn("UsageLimits.timeZone")(function* (tx?: DbTx) {
        const [row] = yield* (tx ?? db)
          .select({ timeZone: limitSettings.timeZone })
          .from(limitSettings)
          .where(eq(limitSettings.id, 1))
          .pipe(Effect.orDie);
        return row?.timeZone ?? "UTC";
      });

      const limitsFor = Effect.fn("UsageLimits.limitsFor")(function* (userId: string, tx?: DbTx) {
        const [person] = yield* (tx ?? db)
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, userId))
          .pipe(Effect.orDie);
        if (!person || person.role === "admin") return [];
        const rules = yield* loadRules(
          or(
            isNull(usageLimits.groupId),
            inArray(
              usageLimits.groupId,
              (tx ?? db)
                .select({ id: groupMembers.groupId })
                .from(groupMembers)
                .where(eq(groupMembers.userId, userId)),
            ),
          ),
          tx,
        );
        return effectiveLimits(
          rules.filter((rule) => rule.groupId === null),
          rules.filter((rule) => rule.groupId !== null),
        );
      });

      /** What a limit has used of its current period, and when that period ends. */
      const usageOf = Effect.fn("UsageLimits.usageOf")(function* (
        userId: string,
        limit: EffectiveLimit,
        zone: string,
        tx?: DbTx,
      ) {
        const { start, resets } = periodBounds(limit.period, zone);
        const conditions = [
          eq(usageEvents.userId, userId),
          sql`${usageEvents.createdAt} >= ${start}`,
          ...(limit.modelIds === null
            ? []
            : limit.modelIds.length
              ? [inArray(usageEvents.modelId, [...limit.modelIds])]
              : [sql`false`]),
          // An answer is a chat attempt that did not fail, a stopped one included. A research
          // run writes a chat row of its own, marked with the generation it ran in.
          ...(limit.metric === "answers"
            ? [
                eq(usageEvents.kind, "chat"),
                ne(usageEvents.status, "error"),
                isNull(usageEvents.generationId),
              ]
            : []),
        ];
        const [row] = yield* (tx ?? db)
          .select({
            used:
              limit.metric === "cost"
                ? sql<number>`coalesce(sum(${usageEvents.cost}), 0)::float8`
                : sql<number>`count(*)::float8`,
            resets: sql<number>`extract(epoch from ${resets})::float8`,
          })
          .from(usageEvents)
          .where(and(...conditions))
          .pipe(Effect.orDie);
        return { used: Number(row?.used ?? 0), resetsAt: new Date(Number(row!.resets) * 1000) };
      });

      const modelNames = Effect.fn("UsageLimits.modelNames")(function* (
        ids: ReadonlyArray<string>,
        tx?: DbTx,
      ) {
        if (!ids.length) return new Map<string, string>();
        const rows = yield* (tx ?? db)
          .select({ id: models.id, name: models.displayName })
          .from(models)
          .where(inArray(models.id, [...ids]))
          .pipe(Effect.orDie);
        return new Map(rows.map((row) => [row.id, row.name]));
      });

      const check = Effect.fn("UsageLimits.check")(function* (
        userId: string,
        modelId: string,
        tx?: DbTx,
      ) {
        const limits = (yield* limitsFor(userId, tx)).filter((limit) =>
          coversModel(limit, modelId),
        );
        if (!limits.length) return;
        const zone = yield* timeZone(tx);
        // Of several used up, the one that resets last says when answers can start again.
        let blocking: { limit: EffectiveLimit; resetsAt: Date } | null = null;
        for (const limit of limits) {
          const { used, resetsAt } = yield* usageOf(userId, limit, zone, tx);
          if (used >= limit.amount && (!blocking || resetsAt > blocking.resetsAt))
            blocking = { limit, resetsAt };
        }
        if (!blocking) return;
        const names = yield* modelNames(blocking.limit.modelIds ?? [], tx);
        return yield* new UsageLimitReached({
          reason: reachedReason(blocking.limit, names, blocking.resetsAt, zone),
          resetsAt: blocking.resetsAt.toISOString(),
        });
      });

      const standing = Effect.fn("UsageLimits.standing")(function* (userId: string) {
        const limits = yield* limitsFor(userId);
        if (!limits.length) return [];
        const zone = yield* timeZone();
        const names = yield* modelNames(limits.flatMap((limit) => limit.modelIds ?? []));
        return yield* Effect.forEach(limits, (limit) =>
          usageOf(userId, limit, zone).pipe(
            Effect.map(({ used, resetsAt }): LimitStanding => ({
              metric: limit.metric,
              period: limit.period,
              amount: limit.amount,
              used,
              models:
                limit.modelIds === null
                  ? null
                  : limit.modelIds.flatMap((id) => {
                      const name = names.get(id);
                      return name ? [{ id, name }] : [];
                    }),
              resetsAt: resetsAt.toISOString(),
              reached: used >= limit.amount,
            })),
          ),
        );
      });

      // Every change to rules takes this, so a group's change and everyone's rule never cross.
      const lockRules = (tx: DbTx) =>
        tx
          .execute(sql`select pg_advisory_xact_lock(hashtextextended('usage-limits', 0))`)
          .pipe(Effect.orDie);

      /**
       * Moves the groups' changes of one of everyone's limits onto what it now counts. A group
       * that already has a rule for that keeps its own, and the old change goes.
       */
      const followEveryone = Effect.fn("UsageLimits.followEveryone")(function* (
        tx: DbTx,
        fromKey: string,
        /** Null drops the groups' rules instead. */
        to: Pick<LimitRule, "metric" | "period" | "modelIds"> | null,
      ) {
        const toKey = to ? limitKey(to) : null;
        const grouped = yield* loadRules(sql`${usageLimits.groupId} is not null`, tx);
        for (const rule of grouped) {
          // A group rule whose models are all gone belongs to no one's limit any more.
          if (limitKey(rule) !== fromKey || rule.modelIds?.length === 0) continue;
          if (
            !to ||
            grouped.some((other) => other.groupId === rule.groupId && limitKey(other) === toKey)
          ) {
            yield* tx.delete(usageLimits).where(eq(usageLimits.id, rule.id)).pipe(Effect.orDie);
            continue;
          }
          yield* tx
            .update(usageLimits)
            .set({ metric: to.metric, period: to.period, allModels: to.modelIds === null })
            .where(eq(usageLimits.id, rule.id))
            .pipe(Effect.orDie);
          yield* tx
            .delete(usageLimitModels)
            .where(eq(usageLimitModels.limitId, rule.id))
            .pipe(Effect.orDie);
          if (to.modelIds?.length)
            yield* tx
              .insert(usageLimitModels)
              .values(to.modelIds.map((modelId) => ({ limitId: rule.id, modelId })))
              .pipe(Effect.orDie);
        }
      });

      const saveRule = Effect.fn("UsageLimits.saveRule")(function* (input: SaveLimitInput) {
        const amount = input.amount;
        if (amount === null && input.groupId === null)
          return yield* new LimitRejected({ reason: localized(m.limits_error_amount_required) });
        if (
          amount !== null &&
          (!Number.isFinite(amount) ||
            amount <= 0 ||
            amount > MAX_AMOUNT ||
            (input.metric === "answers" && !Number.isInteger(amount)))
        )
          return yield* new LimitRejected({
            reason: localized(
              input.metric === "answers"
                ? m.limits_error_answers_amount
                : m.limits_error_cost_amount,
            ),
          });
        const modelIds = input.modelIds === null ? null : [...new Set(input.modelIds)];
        if (modelIds !== null && modelIds.length === 0)
          return yield* new LimitRejected({ reason: localized(m.limits_error_models_required) });
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* lockRules(tx);
              if (input.groupId !== null) {
                const [group] = yield* tx
                  .select({ id: groups.id })
                  .from(groups)
                  .where(eq(groups.id, input.groupId))
                  .for("update")
                  .pipe(Effect.orDie);
                if (!group)
                  return yield* new LimitRejected({ reason: localized(m.limits_error_group_gone) });
              }
              if (modelIds !== null) {
                const known = yield* modelNames(modelIds, tx);
                if (known.size !== modelIds.length)
                  return yield* new LimitRejected({ reason: localized(m.limits_error_model_gone) });
              }
              const scope = yield* loadRules(
                input.groupId === null
                  ? isNull(usageLimits.groupId)
                  : eq(usageLimits.groupId, input.groupId),
                tx,
              );
              const key = limitKey({ metric: input.metric, period: input.period, modelIds });
              if (
                amount === null &&
                !(yield* loadRules(isNull(usageLimits.groupId), tx)).some(
                  (rule) => limitKey(rule) === key,
                )
              )
                return yield* new LimitRejected({
                  reason: localized(m.limits_error_lift_only_everyone),
                });
              if (scope.some((rule) => rule.id !== input.id && limitKey(rule) === key))
                return yield* new LimitRejected({
                  reason: localized(m.limits_error_duplicate),
                });
              const id = input.id ?? uuidv7();
              const previous = input.id ? scope.find((rule) => rule.id === input.id) : undefined;
              if (input.id) {
                const updated = yield* tx
                  .update(usageLimits)
                  .set({
                    metric: input.metric,
                    period: input.period,
                    amount,
                    allModels: modelIds === null,
                  })
                  .where(
                    and(
                      eq(usageLimits.id, input.id),
                      input.groupId === null
                        ? isNull(usageLimits.groupId)
                        : eq(usageLimits.groupId, input.groupId),
                    ),
                  )
                  .returning({ id: usageLimits.id })
                  .pipe(Effect.orDie);
                if (!updated.length)
                  return yield* new LimitRejected({ reason: localized(m.limits_error_rule_gone) });
                yield* tx
                  .delete(usageLimitModels)
                  .where(eq(usageLimitModels.limitId, id))
                  .pipe(Effect.orDie);
              } else {
                yield* tx
                  .insert(usageLimits)
                  .values({
                    id,
                    groupId: input.groupId,
                    metric: input.metric,
                    period: input.period,
                    amount,
                    allModels: modelIds === null,
                  })
                  .pipe(Effect.orDie);
              }
              if (modelIds?.length)
                yield* tx
                  .insert(usageLimitModels)
                  .values(modelIds.map((modelId) => ({ limitId: id, modelId })))
                  .pipe(Effect.orDie);
              // A group's change to everyone's limit follows it to other models. Counting something
              // else, or over another period, its amount means nothing there, so it goes.
              if (
                input.groupId === null &&
                previous &&
                limitKey(previous) !== key &&
                !scope.some(
                  (rule) => rule.id !== previous.id && limitKey(rule) === limitKey(previous),
                )
              )
                yield* followEveryone(
                  tx,
                  limitKey(previous),
                  previous.metric === input.metric && previous.period === input.period
                    ? { metric: input.metric, period: input.period, modelIds }
                    : null,
                );
              return {
                id,
                groupId: input.groupId,
                metric: input.metric,
                period: input.period,
                amount,
                modelIds,
              } satisfies LimitRule;
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
      });

      return UsageLimits.of({
        limitsFor,
        check,
        standing,
        rules: () => loadRules(undefined),
        saveRule,
        deleteRule: Effect.fn("UsageLimits.deleteRule")(function* (id: string) {
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* lockRules(tx);
                const [rule] = yield* loadRules(eq(usageLimits.id, id), tx);
                if (!rule) return;
                // Without everyone's limit, a group's change of it would turn into a limit of its own.
                if (rule.groupId === null) {
                  const everyone = yield* loadRules(isNull(usageLimits.groupId), tx);
                  if (
                    !everyone.some(
                      (other) => other.id !== rule.id && limitKey(other) === limitKey(rule),
                    )
                  )
                    yield* followEveryone(tx, limitKey(rule), null);
                }
                yield* tx.delete(usageLimits).where(eq(usageLimits.id, id)).pipe(Effect.orDie);
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),
        timeZone,
        setTimeZone: Effect.fn("UsageLimits.setTimeZone")(function* (zone: string) {
          // An IANA name both sides read alike: Intl alone also takes offsets like "+05:30",
          // whose sign Postgres reads the other way round.
          const named = zone === "UTC" || Intl.supportedValuesOf("timeZone").includes(zone);
          const known =
            named &&
            isValidTimezone(zone) &&
            (yield* db
              .select({ at: sql`now() at time zone ${zone}` })
              .from(limitSettings)
              .limit(1)
              .pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              ));
          if (!known)
            return yield* new LimitRejected({
              reason: localized(m.limits_error_time_zone_unknown),
            });
          yield* db
            .insert(limitSettings)
            .values({ id: 1, timeZone: zone })
            .onConflictDoUpdate({
              target: limitSettings.id,
              set: { timeZone: zone, updatedAt: sql`now()` },
            })
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
