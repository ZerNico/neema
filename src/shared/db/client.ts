import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { relations } from "./relations.ts";

// Plain (Promise-based) drizzle client. Used by Better Auth's adapter and by
// drizzle-kit tooling. Application services use the Effect-based client from
// ~/server/layers instead — both share this pool.
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
