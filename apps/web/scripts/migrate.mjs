import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

/**
 * Applies pending migrations for a deployment. Bundled by `build-migrate.mjs`
 * into `.output/migrate.mjs` beside a copy of `drizzle/`, so a deployed
 * `.output` needs neither drizzle-kit nor node_modules to migrate itself.
 */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required to migrate.");

const migrationsFolder =
  process.env.MIGRATIONS_FOLDER ?? fileURLToPath(new URL("./drizzle", import.meta.url));

const client = new Client({ connectionString: url });
await client.connect();
try {
  // drizzle's migrator takes no lock, and two replicas starting together would
  // both apply the same pending migration. The lock is session-scoped, so it
  // must be taken on the one connection the migrator then uses.
  await client.query("select pg_advisory_lock(hashtext('chat:migrations'))");
  await migrate(drizzle({ client }), { migrationsFolder });
  console.log("Migrations applied.");
} finally {
  await client.end();
}
