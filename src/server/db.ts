import { PgClient } from "@effect/sql-pg";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import { Config, Context, Effect, Layer } from "effect";
import { relations } from "~/shared/db/relations.ts";

// Effect-native Postgres client (pooled). Also powers LISTEN/NOTIFY for sync.
export const PgLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
  maxConnections: Config.succeed(10),
});

const makeDb = makeWithDefaults({ relations });

// Note: requires PgClient — provided once at the composition root so the
// SyncBus (LISTEN/NOTIFY) shares the same pool.
export class Db extends Context.Service<Db, Effect.Success<typeof makeDb>>()("chat/server/Db") {
  static readonly layer: Layer.Layer<Db, never, PgClient.PgClient> = Layer.effect(Db, makeDb);
}
