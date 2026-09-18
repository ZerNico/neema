import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { relations } from "./relations.ts";

// Plain (Promise-based) drizzle client with its own small pg pool. This exists
// ONLY for Better Auth's Drizzle adapter, which needs a non-Effect client.
// Application code must use the `Db` service (Effect client on @effect/sql-pg)
// provided by ~/server/db.ts. Do not import this from modules.
let pool: Pool | undefined;

export function getPool() {
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });
  return pool;
}

let db: ReturnType<typeof createDb> | undefined;

function createDb() {
  return drizzle({ client: getPool(), relations });
}

export function getDb() {
  db ??= createDb();
  return db;
}

export type Db = ReturnType<typeof getDb>;
