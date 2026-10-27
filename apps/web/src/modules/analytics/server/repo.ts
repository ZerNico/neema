import { and, asc, desc, eq, exists, gte, lt, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import { models, usageEvents, user } from "~/db/schema/index.ts";
import type { CostSource } from "~/db/schema/analytics.ts";

// PostgreSQL sums integer token columns as bigint. Keep that width in SQL,
// then reject totals outside JS's exact integer range rather than silently rounding.
const tokenTotal = (value: unknown): number => {
  const total = Number(value);
  if (!Number.isSafeInteger(total)) throw new RangeError("Token total exceeds safe integer range");
  return total;
};

export type UsageEventRow = typeof usageEvents.$inferSelect;

// A model can be deleted while its call runs. Linking under a row lock either
// holds the model until this write commits or finds it gone and links nothing;
// the saved name labels the row either way.
export const liveModelId = (modelId: string | null) =>
  modelId === null
    ? null
    : sql<
        string | null
      >`(select ${models.id} from ${models} where ${models.id} = ${modelId} for key share)`;

export interface UsageEventInput {
  userId: string;
  kind: UsageEventRow["kind"];
  modelId: string | null;
  modelName: string;
  conversationId?: string;
  messageId?: string;
  status: "complete" | "error" | "aborted";
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Null: the provider said nothing about cache writes. */
  cacheWriteTokens: number | null;
  reasoningTokens: number;
  usageComplete?: boolean;
  cost: number | null;
  costSource: CostSource | null;
  /** Image operations: images the provider made, and the call they served. */
  imageCount?: number;
  toolCallId?: string;
  generationId?: string;
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
  /** Chat generations only, title runs are counted in tokens, not here. */
  messages: number;
  /** Every provider attempt of any kind, the error-rate divisor. */
  attempts: number;
  titleGenerations: number;
  compactionGenerations: number;
  /** Checks of computer calls under "ask when risky". */
  reviewGenerations: number;
  /** Image operations, each its own attempt, and the images they made. */
  imageGenerations: number;
  images: number;
  errorAttempts: number;
  abortedAttempts: number;
  inputTokens: number;
  outputTokens: number;
  /** Cache reads, already included in `inputTokens`, not an addend. */
  cachedInputTokens: number;
  /** Cache writes, also inside `inputTokens`; rows whose provider never said count nothing. */
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
  /** False when any event has unknown cost or incomplete usage, so the sum is a floor. */
  costComplete: boolean;
  activeUsers: number;
}

export interface UsageDay {
  /** ISO date (YYYY-MM-DD), UTC bucket. */
  day: string;
  messages: number;
  images: number;
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
  /** False when no model row backs these rows (deleted, or a service without one); they group by saved name. */
  linked: boolean;
  messages: number;
  images: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  costComplete: boolean;
}

export interface UsageByUser {
  userId: string;
  name: string;
  email: string;
  messages: number;
  images: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  costComplete: boolean;
}

const inWindow = (scope: UsageScope) =>
  and(gte(usageEvents.createdAt, scope.from), lt(usageEvents.createdAt, scope.to));

const inScope = (scope: UsageScope) =>
  scope.userId ? and(inWindow(scope), eq(usageEvents.userId, scope.userId)) : inWindow(scope);

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

      // Sums are null over zero rows; coalesce keeps the shape numeric.
      const sums = {
        messages: sql<number>`count(*) filter (where ${usageEvents.kind} = 'chat')::int`,
        images: sql<number>`coalesce(sum(${usageEvents.imageCount}), 0)::int`,
        inputTokens: sql`coalesce(sum(${usageEvents.inputTokens}), 0)`.mapWith(tokenTotal),
        outputTokens: sql`coalesce(sum(${usageEvents.outputTokens}), 0)`.mapWith(tokenTotal),
        cost: sql<number>`coalesce(sum(${usageEvents.cost}), 0)`,
      };

      const costCompleteness = {
        costComplete: sql<boolean>`count(*) filter (where ${usageEvents.cost} is null or not ${usageEvents.usageComplete}) = 0`,
      };

      // Only summary and daily need these; the grouped tables stay narrow.
      const detail = {
        attempts: sql<number>`count(*)::int`,
        errorAttempts: sql<number>`count(*) filter (where ${usageEvents.status} = 'error')::int`,
        cachedInputTokens: sql`coalesce(sum(${usageEvents.cachedInputTokens}), 0)`.mapWith(
          tokenTotal,
        ),
        reasoningTokens: sql`coalesce(sum(${usageEvents.reasoningTokens}), 0)`.mapWith(tokenTotal),
      };

      return AnalyticsRepo.of({
        record: Effect.fn("AnalyticsRepo.record")(function* (event) {
          yield* db
            .insert(usageEvents)
            .values({ id: uuidv7(), ...event, modelId: liveModelId(event.modelId) })
            .pipe(Effect.orDie);
        }),

        summary: Effect.fn("AnalyticsRepo.summary")(function* (scope) {
          // People with a row in the window, one index probe each. A distinct
          // count over the rows sorted the whole window and spilled to disk.
          const activeUsers = db
            .select({ count: sql<number>`count(*)::int` })
            .from(user)
            .where(
              and(
                scope.userId ? eq(user.id, scope.userId) : undefined,
                exists(
                  db
                    .select({ one: sql`1` })
                    .from(usageEvents)
                    .where(and(eq(usageEvents.userId, user.id), inWindow(scope))),
                ),
              ),
            )
            .pipe(Effect.orDie);
          const totals = db
            .select({
              ...sums,
              ...detail,
              titleGenerations: sql<number>`count(*) filter (where ${usageEvents.kind} = 'title')::int`,
              compactionGenerations: sql<number>`count(*) filter (where ${usageEvents.kind} = 'compaction')::int`,
              reviewGenerations: sql<number>`count(*) filter (where ${usageEvents.kind} = 'review')::int`,
              imageGenerations: sql<number>`count(*) filter (where ${usageEvents.kind} = 'image')::int`,
              abortedAttempts: sql<number>`count(*) filter (where ${usageEvents.status} = 'aborted')::int`,
              ...costCompleteness,
              cacheWriteTokens: sql`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`.mapWith(
                tokenTotal,
              ),
            })
            .from(usageEvents)
            .where(inScope(scope))
            .pipe(Effect.orDie);
          const [rows, active] = yield* Effect.all([totals, activeUsers], {
            concurrency: "unbounded",
          });
          const row = rows[0]!;
          return {
            messages: row.messages,
            attempts: row.attempts,
            titleGenerations: row.titleGenerations,
            compactionGenerations: row.compactionGenerations,
            reviewGenerations: row.reviewGenerations,
            imageGenerations: row.imageGenerations,
            images: row.images,
            errorAttempts: row.errorAttempts,
            abortedAttempts: row.abortedAttempts,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cachedInputTokens: row.cachedInputTokens,
            cacheWriteTokens: row.cacheWriteTokens,
            reasoningTokens: row.reasoningTokens,
            cost: row.cost,
            costComplete: row.costComplete,
            activeUsers: active[0]?.count ?? 0,
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
          // A model that still exists is one line under its current name, across
          // renames. Deleting it clears the link, so its rows fall back to their saved name.
          const savedName = sql`case when ${usageEvents.modelId} is null then ${usageEvents.modelName} end`;
          return yield* db
            .select({
              modelName: sql<string>`coalesce(${models.displayName}, min(${usageEvents.modelName}))`,
              linked: sql<boolean>`${usageEvents.modelId} is not null`,
              ...sums,
              ...costCompleteness,
            })
            .from(usageEvents)
            .leftJoin(models, eq(models.id, usageEvents.modelId))
            .where(inScope(scope))
            .groupBy(usageEvents.modelId, models.displayName, savedName)
            .orderBy(
              desc(sql`sum(${usageEvents.inputTokens}) + sum(${usageEvents.outputTokens})`),
              desc(sql`coalesce(sum(${usageEvents.cost}), 0)`),
            )
            .pipe(Effect.orDie);
        }),

        byUser: Effect.fn("AnalyticsRepo.byUser")(function* (scope) {
          return yield* db
            .select({
              userId: user.id,
              name: user.name,
              email: user.email,
              ...sums,
              ...costCompleteness,
            })
            .from(usageEvents)
            .innerJoin(user, eq(user.id, usageEvents.userId))
            .where(inWindow(scope))
            .groupBy(user.id, user.name, user.email)
            .orderBy(
              desc(sql`sum(${usageEvents.inputTokens}) + sum(${usageEvents.outputTokens})`),
              desc(sql`coalesce(sum(${usageEvents.cost}), 0)`),
            )
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
