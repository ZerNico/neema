import { PgClient } from "@effect/sql-pg";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import { Config, Context, Effect, Layer } from "effect";
import { relations } from "~/db/relations.ts";

/**
 * Effect-native Postgres client (pooled). Also powers LISTEN/NOTIFY for sync.
 */
export const PgLive = PgClient.layerConfig({
  url: Config.Redacted("DATABASE_URL"),
  maxConnections: Config.succeed(10),
});

const makeDb = makeWithDefaults({ relations });

/**
 * PgClient is provided once at the composition root. Sync publications share
 * its pool; the reconnectable listener owns one connection with the same config.
 */
export class Db extends Context.Service<Db, Effect.Success<typeof makeDb>>()("chat/server/Db") {
  static readonly layer: Layer.Layer<Db, never, PgClient.PgClient> = Layer.effect(Db, makeDb);
}
