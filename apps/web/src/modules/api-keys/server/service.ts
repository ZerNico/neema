import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { apiKeys } from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";
import { API_KEY_PREFIX, MAX_API_KEYS, type ApiKeySummary, type NewApiKey } from "../schema.ts";

export class ApiKeyLimitReached extends Schema.TaggedError<ApiKeyLimitReached>()(
  "ApiKeyLimitReached",
  {},
) {}

/** What a valid key proves: one person, through this key, with these scopes. */
export interface ApiKeyGrant {
  id: string;
  userId: string;
  name: string;
  scopes: ReadonlyArray<string>;
  expiresAt: Date | null;
}

const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Long enough to tell keys apart, far too short to guess the rest from. */
const START_LENGTH = API_KEY_PREFIX.length + 6;

const summary = (row: typeof apiKeys.$inferSelect): ApiKeySummary => ({
  id: row.id,
  name: row.name,
  start: row.start,
  scopes: row.scopes,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  createdAt: row.createdAt,
});

export class ApiKeys extends Context.Service<
  ApiKeys,
  {
    list(userId: string): Effect.Effect<ReadonlyArray<ApiKeySummary>>;
    /** The new key and its secret, which is never readable again. */
    create(
      userId: string,
      input: NewApiKey,
    ): Effect.Effect<{ key: ApiKeySummary; secret: string }, ApiKeyLimitReached>;
    revoke(userId: string, id: string): Effect.Effect<void>;
    /** The grant behind a secret, or null for an unknown or expired one. */
    verify(secret: string): Effect.Effect<ApiKeyGrant | null>;
    name(id: string): Effect.Effect<string | null>;
  }
>()("chat/api-keys/ApiKeys") {
  static readonly layer = Layer.effect(
    ApiKeys,
    Effect.gen(function* () {
      const db = yield* Db;
      return {
        list: Effect.fn("ApiKeys.list")(function* (userId) {
          const rows = yield* db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.userId, userId))
            .orderBy(desc(apiKeys.createdAt))
            .pipe(Effect.orDie);
          return rows.map(summary);
        }),
        create: Effect.fn("ApiKeys.create")(function* (userId, input) {
          const secret = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
          const row = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                // Counted under a lock per person, so two creations at once
                // cannot both pass the limit.
                yield* tx.execute(
                  sql`select pg_advisory_xact_lock(hashtextextended(${`api_keys:${userId}`}, 0))`,
                );
                const [held] = yield* tx
                  .select({ n: count() })
                  .from(apiKeys)
                  .where(eq(apiKeys.userId, userId));
                if ((held?.n ?? 0) >= MAX_API_KEYS) return null;
                const [created] = yield* tx
                  .insert(apiKeys)
                  .values({
                    id: uuidv7(),
                    userId,
                    name: input.name.trim(),
                    start: secret.slice(0, START_LENGTH),
                    hash: hashOf(secret),
                    scopes: [...input.scopes],
                    // Judged by the database clock, as every check of it is.
                    expiresAt:
                      input.lifetimeDays === null
                        ? null
                        : sql`now() + make_interval(days => ${input.lifetimeDays})`,
                  })
                  .returning();
                return created!;
              }),
            )
            .pipe(Effect.orDie);
          if (!row) return yield* new ApiKeyLimitReached();
          return { key: summary(row), secret };
        }),
        revoke: Effect.fn("ApiKeys.revoke")(function* (userId, id) {
          yield* db
            .delete(apiKeys)
            .where(and(eq(apiKeys.userId, userId), eq(apiKeys.id, id)))
            .pipe(Effect.orDie);
        }),
        verify: Effect.fn("ApiKeys.verify")(function* (secret) {
          if (!secret.startsWith(API_KEY_PREFIX)) return null;
          const [row] = yield* db
            .select()
            .from(apiKeys)
            .where(
              and(
                eq(apiKeys.hash, hashOf(secret)),
                or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`)),
              ),
            )
            .pipe(Effect.orDie);
          if (!row) return null;
          // At most once a minute, so a busy key is not a write per request.
          yield* db
            .update(apiKeys)
            .set({ lastUsedAt: sql`now()` })
            .where(
              and(
                eq(apiKeys.id, row.id),
                or(
                  isNull(apiKeys.lastUsedAt),
                  lt(apiKeys.lastUsedAt, sql`now() - interval '1 minute'`),
                ),
              ),
            )
            .pipe(Effect.orDie);
          return {
            id: row.id,
            userId: row.userId,
            name: row.name,
            scopes: row.scopes,
            expiresAt: row.expiresAt,
          };
        }),
        name: Effect.fn("ApiKeys.name")(function* (id) {
          const [row] = yield* db
            .select({ name: apiKeys.name })
            .from(apiKeys)
            .where(eq(apiKeys.id, id))
            .pipe(Effect.orDie);
          return row?.name ?? null;
        }),
      };
    }),
  );
}
