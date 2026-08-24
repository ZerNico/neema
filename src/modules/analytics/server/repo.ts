import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import { usageEvents, user } from "~/db/schema/index.ts";

export type UsageEventRow = typeof usageEvents.$inferSelect;

export interface UsageEventInput {
  userId: string;
  kind: "chat" | "title" | "compaction";
  modelId: string | null;
  modelName: string;
  conversationId?: string;
  messageId?: string;
  status: "complete" | "error" | "aborted";
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  cost: number | null;
  costSource: "provider" | "pricing" | null;
}

/**
 * All reads take the same scope: a half-open window, optionally one user's.
 *
 * `to` is exclusive so the prior-period window can end exactly where this one
 * begins without double-counting the instant they share.
 */
export interface UsageScope {
  from: Date;
  to: Date;
  userId?: string;
}

export interface UsageSummary {
  /** Chat generations only — title runs are counted in tokens, not here. */
  messages: number;
  /** Every generation attempt of any kind — the error-rate divisor. */
  attempts: number;
  titleGenerations: number;
  compactionGenerations: number;
  errorAttempts: number;
  abortedAttempts: number;
  inputTokens: number;
  outputTokens: number;
  /** Cache reads, already included in `inputTokens` — not an addend. */
  cachedInputTokens: number;
  reasoningTokens: number;
  cost: number;
  /** False when any event in range has unknown cost — the total is a floor. */
  costComplete: boolean;
  activeUsers: number;
}

export interface UsageDay {
  /** ISO date (YYYY-MM-DD), UTC bucket. */
  day: string;
  messages: number;
  attempts: number;
  errorAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  cost: number;
}

export interface UsageByModel {
  modelName: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageByUser {
  userId: string;
  name: string;
  email: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export class AnalyticsRepo extends Context.Service<
  AnalyticsRepo,
  {
    /** Append one ledger row. Rows are never updated or deleted afterwards. */
    record(event: UsageEventInput): Effect.Effect<void>;
    summary(scope: UsageScope): Effect.Effect<UsageSummary>;
    daily(scope: UsageScope): Effect.Effect<UsageDay[]>;
    byModel(scope: UsageScope): Effect.Effect<UsageByModel[]>;
    byUser(scope: UsageScope): Effect.Effect<UsageByUser[]>;
  }
>()("chat/analytics/AnalyticsRepo") {
  static readonly layer = Layer.effect(
    AnalyticsRepo,
    Effect.gen(function* () {
      const db = yield* Db;

      const inWindow = (scope: UsageScope) =>
        and(gte(usageEvents.createdAt, scope.from), lt(usageEvents.createdAt, scope.to));

      const inScope = (scope: UsageScope) =>
        scope.userId ? and(inWindow(scope), eq(usageEvents.userId, scope.userId)) : inWindow(scope);

      // Sums are null over zero rows; coalesce keeps the shape numeric.
      const sums = {
        messages: sql<number>`count(*) filter (where ${usageEvents.kind} = 'chat')::int`,
        inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`,
        cost: sql<number>`coalesce(sum(${usageEvents.cost}), 0)`,
      };

      // Only summary and daily need these; the grouped tables stay narrow.
      const detail = {
        attempts: sql<number>`count(*)::int`,
        errorAttempts: sql<number>`count(*) filter (where ${usageEvents.status} = 'error')::int`,
        cachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::int`,
        reasoningTokens: sql<number>`coalesce(sum(${usageEvents.reasoningTokens}), 0)::int`,
      };

      return AnalyticsRepo.of({
        record: Effect.fn("AnalyticsRepo.record")(function* (event) {
          yield* db
            .insert(usageEvents)
            .values({ id: uuidv7(), ...event })
            .pipe(Effect.orDie);
        }),

        summary: Effect.fn("AnalyticsRepo.summary")(function* (scope) {
          const rows = yield* db
            .select({
              ...sums,
              ...detail,
              titleGenerations: sql<number>`count(*) filter (where ${usageEvents.kind} = 'title')::int`,
              compactionGenerations: sql<number>`count(*) filter (where ${usageEvents.kind} = 'compaction')::int`,
              abortedAttempts: sql<number>`count(*) filter (where ${usageEvents.status} = 'aborted')::int`,
              unknownCost: sql<number>`count(*) filter (where ${usageEvents.cost} is null)::int`,
              activeUsers: sql<number>`count(distinct ${usageEvents.userId})::int`,
            })
            .from(usageEvents)
            .where(inScope(scope))
            .pipe(Effect.orDie);
          const row = rows[0]!;
          return {
            messages: row.messages,
            attempts: row.attempts,
            titleGenerations: row.titleGenerations,
            compactionGenerations: row.compactionGenerations,
            errorAttempts: row.errorAttempts,
            abortedAttempts: row.abortedAttempts,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cachedInputTokens: row.cachedInputTokens,
            reasoningTokens: row.reasoningTokens,
            cost: row.cost,
            costComplete: row.unknownCost === 0,
            activeUsers: row.activeUsers,
          };
        }),

        daily: Effect.fn("AnalyticsRepo.daily")(function* (scope) {
          const day = sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
          return yield* db
            .select({ day, ...sums, ...detail })
            .from(usageEvents)
            .where(inScope(scope))
            .groupBy(day)
            .orderBy(asc(day))
            .pipe(Effect.orDie);
        }),

        byModel: Effect.fn("AnalyticsRepo.byModel")(function* (scope) {
          return yield* db
            .select({ modelName: usageEvents.modelName, ...sums })
            .from(usageEvents)
            .where(inScope(scope))
            .groupBy(usageEvents.modelName)
            .orderBy(desc(sql`sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens})`))
            .pipe(Effect.orDie);
        }),

        byUser: Effect.fn("AnalyticsRepo.byUser")(function* (scope) {
          return yield* db
            .select({ userId: user.id, name: user.name, email: user.email, ...sums })
            .from(usageEvents)
            .innerJoin(user, eq(user.id, usageEvents.userId))
            .where(inWindow(scope))
            .groupBy(user.id, user.name, user.email)
            .orderBy(desc(sql`sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens})`))
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
