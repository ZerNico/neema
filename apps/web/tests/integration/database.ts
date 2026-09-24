import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { inject } from "vitest";

/** Migrated once by global-setup.ts; never connected to afterwards, so it can be cloned. */
export const TEMPLATE_DATABASE = "migrated_template";

export interface TestDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

const admin = async <A>(f: (client: Client) => Promise<A>) => {
  const client = new Client({ connectionString: inject("postgresAdminUrl") });
  await client.connect();
  try {
    return await f(client);
  } finally {
    await client.end();
  }
};

/**
 * A database of this file's own on the run's shared server. Pass
 * `migrated: false` for a test that applies migrations itself.
 */
export const createTestDatabase = async ({ migrated = true } = {}): Promise<TestDatabase> => {
  const name = `test_${uuidv7().replaceAll("-", "")}`;
  await admin(async (client) => {
    // Postgres refuses a clone while another clone reads the same template.
    await client.query("select pg_advisory_lock(hashtext('clone-test-template'))");
    await client.query(
      migrated ? `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}` : `CREATE DATABASE ${name}`,
    );
  });
  const url = new URL(inject("postgresAdminUrl"));
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => admin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).then(
      () => undefined,
    ),
  };
};
