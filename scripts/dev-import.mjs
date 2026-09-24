import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activateSnapshot,
  instanceEnv,
  instancePaths,
  loadInstance,
  safeError,
} from "./dev-state.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "apps/web/package.json"));
const { Client } = require("pg");
export const compose = [
  "compose",
  "--project-name",
  "chat-development",
  "--file",
  join(root, "docker-compose.yml"),
];
const interrupted = "Interrupted by development snapshot import.";
const changedBlob =
  "A primary file changed during the copy, likely removed by its running app. Run the import again.";

export async function connect(url, readonly = false) {
  const connection = new URL(url);
  if (readonly) connection.searchParams.set("options", "-c default_transaction_read_only=on");
  const client = new Client({
    connectionString: connection.toString(),
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  return client;
}

export async function sourceConfig(checkoutRoot) {
  // The primary checkout is the only seed source; worktrees never read an env file.
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: checkoutRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const primaryRoot = dirname(common);
  const currentRoot = await realpath(checkoutRoot);
  if (primaryRoot === currentRoot)
    throw safeError(
      "The primary checkout is the seed source. Configure it directly instead of importing it into itself.",
    );
  let primary;
  try {
    primary = await loadInstance(primaryRoot);
  } catch (cause) {
    throw safeError(
      "The primary checkout is not set up. Run pnpm dev:setup there before seeding a worktree.",
      { cause },
    );
  }
  return {
    url: instanceEnv(primary).DATABASE_URL,
    providerSecret: primary.providerSecret,
    blobs: primary.blobs,
  };
}

export async function checkMigrations(client, migrations = join(root, "apps/web/drizzle")) {
  const { rows } = await client.query(
    "SELECT name, hash FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  const local = new Set(await readdir(migrations));
  for (const row of rows) {
    if (!row.name || !local.has(row.name))
      throw safeError(
        "The primary has migrations this checkout lacks. Rebase or merge main, then import again.",
      );
    const sql = await readFile(join(migrations, row.name, "migration.sql"));
    if (createHash("sha256").update(sql).digest("hex") !== row.hash)
      throw safeError(`Migration ${row.name} differs between the primary and this checkout.`);
  }
}

export async function assertIdle(admin, instance) {
  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
    [instance.database],
  );
  if (rows[0].n !== 0)
    throw safeError(
      "This checkout’s database has active connections. Stop this checkout’s dev server and database tools first; the primary can keep running.",
    );
}

const snapshotPattern = (instance) => new RegExp(`^chat_dev_${instance.id}_[a-f0-9]{16}$`);

// A database outlives the checkout that made it, and the name only carries a one-way hash.
// Recording the path lets a later sweep name what it is about to drop; Postgres does the quoting.
export async function tagCheckout(admin, database, checkoutRoot) {
  const { rows } = await admin.query(
    "SELECT format('COMMENT ON DATABASE %I IS %L', $1::text, $2::text) AS sql",
    [database, checkoutRoot],
  );
  await admin.query(rows[0].sql);
}

// Grouped by instance id so an orphan is retired as one unit: base, snapshots and role together.
export async function instanceGroups(admin) {
  const { rows } =
    await admin.query(`SELECT datname, shobj_description(oid, 'pg_database') AS checkout
    FROM pg_database WHERE datname ~ '^chat_dev_[0-9a-f]{16}(_[0-9a-f]{16})?$' ORDER BY datname`);
  const groups = new Map();
  for (const row of rows) {
    const id = row.datname.slice(9, 25);
    const group = groups.get(id) ?? { id, databases: [], checkout: null };
    group.databases.push(row.datname);
    group.checkout ??= row.checkout;
    groups.set(id, group);
  }
  return [...groups.values()];
}

export async function managedDatabases(admin, instance) {
  const base = instancePaths(instance.root).database;
  const { rows } = await admin.query(
    "SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2",
    [base, `${base}_%`],
  );
  return rows
    .map(({ datname }) => datname)
    .filter((database) => database === base || snapshotPattern(instance).test(database));
}

export async function pruneInactiveSnapshots(admin, instance) {
  const current = await loadInstance(instance.root);
  const base = instancePaths(current.root);
  const databases = (await managedDatabases(admin, current)).filter(
    (database) => database !== current.database,
  );
  for (const database of databases) {
    await assertIdle(admin, { ...current, database });
    await admin.query(`DROP DATABASE ${database}`);
  }
  const snapshots = join(base.directory, "snapshots");
  const directories = await readdir(snapshots, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of directories) {
    if (
      !entry.isDirectory() ||
      !/^[a-f0-9]{16}$/.test(entry.name) ||
      entry.name === current.snapshot
    )
      continue;
    await rm(join(snapshots, entry.name), { recursive: true, force: true });
  }
  if (current.snapshot) {
    await rm(base.blobs, { recursive: true, force: true });
    await rm(base.profile, { recursive: true, force: true });
  }
  return databases;
}

export async function sanitize(client) {
  await client.query("BEGIN");
  try {
    // OAuth is disabled in the copy, so an OAuth-only snapshot would lose its sign-in path.
    const { rows } = await client.query(`SELECT EXISTS (SELECT 1 FROM "user") AND NOT EXISTS (
      SELECT 1 FROM account WHERE provider_id = 'credential' AND nullif(password, '') IS NOT NULL
    ) AS locked_out`);
    if (rows[0].locked_out)
      throw safeError(
        "Snapshot has no password sign-in account. OAuth is disabled in development copies; import refused. Previous state retained.",
      );
    await client.query(`DELETE FROM session; DELETE FROM verification;
      UPDATE account SET access_token = NULL, refresh_token = NULL, id_token = NULL,
        access_token_expires_at = NULL, refresh_token_expires_at = NULL;
      UPDATE oauth_providers SET enabled = false;
      DELETE FROM blob_cleanup_intents;`);
    await client.query(
      `UPDATE messages m SET status = 'error', generation_lease_until = NULL,
      content = coalesce((SELECT string_agg(delta, '' ORDER BY seq) FROM message_chunks WHERE message_id=m.id AND kind='text'), m.content),
      reasoning = coalesce((SELECT string_agg(delta, '' ORDER BY seq) FROM message_chunks WHERE message_id=m.id AND kind='reasoning'), m.reasoning),
      error = jsonb_build_object('tag', 'GenerationFailed', 'message', $1::text), completed_at = now()
      WHERE status = 'streaming'`,
      [interrupted],
    );
    for (const table of ["message_tool_calls", "message_compaction_events"]) {
      await client.query(
        `UPDATE ${table} SET status = 'error', completed_at = now(),
        error = jsonb_build_object('code', 'GenerationFailed', 'message', $1::text) WHERE status = 'running'`,
        [interrupted],
      );
    }
    await client.query(`UPDATE research_runs SET status='terminal', owner=NULL, lease_until=now(),
      cancel_requested=true, completed_at=now(), progress=progress || '{"phase":"error"}'::jsonb
      WHERE status IN ('queued','running');
      UPDATE research_tasks SET status='aborted' WHERE status IN ('queued','running');
      UPDATE research_calls SET status='error' WHERE status='running';`);
    await client.query(
      `UPDATE knowledge_document_versions SET status='failed', lease_token=NULL, lease_until=NULL, error=$1
      WHERE status IN ('queued','extracting')`,
      [interrupted],
    );
    await client.query(
      `UPDATE knowledge_embedding_jobs SET status='failed', lease_token=NULL, lease_until=NULL, error=$1, updated_at=now()
      WHERE status IN ('queued','running')`,
      [interrupted],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function copyBlobs(client, sourceRoot, targetRoot) {
  const { rows } = await client.query("SELECT storage_key, sha256, size FROM attachment_blobs");
  if (rows.length === 0) return 0;
  const source = await realpath(sourceRoot);
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const target = await realpath(targetRoot);
  if (source === target || target.startsWith(source + sep) || source.startsWith(target + sep))
    throw new Error("Source and target blob roots overlap.");
  for (const row of rows) {
    const key = row.storage_key;
    if (
      typeof key !== "string" ||
      !key.startsWith("blobs/") ||
      key.split("/").some((part) => !part || part === "." || part === "..") ||
      key.includes("\\") ||
      key.includes("\0")
    )
      throw new Error("Invalid source blob key.");
    // The primary may be running, and its reconciler can delete a blob after the dump.
    const path = await realpath(join(source, key)).catch((error) => {
      if (error.code === "ENOENT") throw safeError(changedBlob);
      throw error;
    });
    if (!path.startsWith(source + sep)) throw new Error("Source blob escapes storage root.");
    const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const destination = join(target, key);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    let output;
    try {
      if (!(await input.stat()).isFile()) throw new Error("Source blob is not a regular file.");
      output = await open(destination, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        hash.update(chunk);
        size += chunk.length;
        await output.writeFile(chunk);
      }
      if (size !== Number(row.size) || hash.digest("hex") !== row.sha256)
        throw safeError(changedBlob);
    } finally {
      await input.close();
      await output?.close();
    }
  }
  return rows.length;
}

// Connection fields travel over stdin, not argv or Docker's persisted environment.
async function archiveCommand(kind, url, archive, run, transport) {
  const connection = new URL(url);
  // Source and target are checkout databases in this container's one dev server.
  connection.hostname = "127.0.0.1";
  connection.port = "5432";
  const fields = [
    connection.hostname,
    connection.port || "5432",
    decodeURIComponent(connection.username),
    decodeURIComponent(connection.password),
    decodeURIComponent(connection.pathname.slice(1)),
    connection.searchParams.get("sslmode") || "prefer",
  ];
  if (fields.some((field) => /[\r\n\0]/.test(field)))
    throw new Error("Unsupported PostgreSQL connection field.");
  const file = await open(archive, kind === "dump" ? "wx" : "r", 0o600);
  try {
    await run(
      "docker",
      [
        ...transport.exec,
        "sh",
        "-c",
        "IFS= read -r PGHOST; IFS= read -r PGPORT; IFS= read -r PGUSER; IFS= read -r PGPASSWORD; IFS= read -r PGDATABASE; IFS= read -r PGSSLMODE; export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE; export PGCONNECT_TIMEOUT=10; " +
          (kind === "dump"
            ? 'export PGOPTIONS="-c default_transaction_read_only=on"; exec pg_dump --format=custom --no-owner --no-acl'
            : 'exec pg_restore --no-owner --no-acl --no-comments --exit-on-error --dbname="$PGDATABASE"'),
      ],
      {
        input: fields.join("\n") + "\n",
        archive: file.fd,
        restoring: kind !== "dump",
        quiet: true,
      },
    );
  } finally {
    await file.close();
  }
}

export async function importSnapshot(
  instance,
  source,
  run,
  adminUrl = "postgres://chat_dev_admin:local-development-only@127.0.0.1:5433/postgres",
  transport = { exec: [...compose, "exec", "-T", "postgres"] },
) {
  const admin = await connect(adminUrl);
  let sourceClient;
  let stagedClient;
  let created = false;
  let activated = false;
  const snapshot = randomBytes(8).toString("hex");
  const database = `chat_dev_${instance.id}_${snapshot}`;
  const directory = join(instance.directory, "snapshots", snapshot);
  const staged = {
    ...instance,
    database,
    blobs: join(directory, "storage"),
    profile: join(directory, "desktop"),
    providerSecret: source.providerSecret,
  };
  const archive = join(directory, "snapshot.dump");
  try {
    await assertIdle(admin, instance);
    sourceClient = await connect(source.url, true);
    // Database names are unique per checkout on our dedicated server; reject them even through aliases.
    const { rows: identity } = await sourceClient.query("SELECT current_database() AS name");
    if (identity[0].name.startsWith(`chat_dev_${instance.id}`))
      throw safeError("Cannot import this checkout's own database.");
    await checkMigrations(sourceClient);
    await sourceClient.end();
    sourceClient = null;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    console.log("Reading source snapshot (source is read-only)…");
    await archiveCommand("dump", source.url, archive, run, transport);
    await admin.query(`CREATE DATABASE ${database} OWNER chat_dev_${instance.id}`);
    created = true;
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    // Before restore: pg_restore runs --no-comments, so the source cannot overwrite this.
    await tagCheckout(admin, database, instance.root);
    const extensionUrl = new URL(adminUrl);
    extensionUrl.pathname = `/${database}`;
    const extensionClient = await connect(extensionUrl.toString());
    try {
      await extensionClient.query("CREATE EXTENSION IF NOT EXISTS vector");
    } finally {
      await extensionClient.end();
    }
    const env = instanceEnv(staged);
    const targetUrl = new URL(env.DATABASE_URL);
    targetUrl.hostname = extensionUrl.hostname;
    targetUrl.port = extensionUrl.port;
    env.DATABASE_URL = targetUrl.toString();
    console.log("Restoring and migrating isolated copy…");
    await archiveCommand("restore", env.DATABASE_URL, archive, run, transport);
    stagedClient = await connect(env.DATABASE_URL);
    await checkMigrations(stagedClient);
    await run("pnpm", ["--filter", "@chat/web", "db:migrate"], { env, quiet: true });
    await sanitize(stagedClient);
    const count = await copyBlobs(stagedClient, source.blobs, staged.blobs);
    await stagedClient.end();
    stagedClient = null;
    await rm(archive);
    await assertIdle(admin, instance);
    await activateSnapshot(instance, snapshot, source.providerSecret);
    activated = true;
    const current = await loadInstance(instance.root);
    try {
      const stale = await pruneInactiveSnapshots(admin, current);
      if (stale.length > 0)
        console.log(
          `Removed ${stale.length} replaced development snapshot${stale.length === 1 ? "" : "s"}.`,
        );
    } catch (error) {
      console.warn(`Imported state is active, but stale snapshots remain: ${error.message}`);
    }
    console.log(
      `Imported snapshot with ${count} blobs.\nRun pnpm dev; sign in with your existing email/password. OAuth sign-in is disabled in the copy.`,
    );
    return current;
  } finally {
    await sourceClient?.end();
    await stagedClient?.end();
    try {
      if (!activated && created) await admin.query(`DROP DATABASE ${database}`);
      if (!activated) await rm(directory, { recursive: true, force: true });
    } finally {
      await admin.end();
    }
  }
}

export function runImportCommand(executable, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio:
        options.archive !== undefined && !options.restoring
          ? ["pipe", options.archive, "pipe"]
          : ["pipe", options.quiet ? "pipe" : "inherit", "pipe"],
    });
    child.stdout?.resume();
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error(`Could not launch ${executable}.`)));
    child.once("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(
            new Error(
              `${executable} failed during snapshot import (exit ${code}); connection details suppressed.`,
            ),
          ),
    );
    if (options.restoring) {
      // Preserve stdin ordering: the shell consumes one URL line, pg_restore consumes the archive.
      child.stdin.write(options.input);
      const stream = createReadStream("", { fd: options.archive, autoClose: false });
      stream.on("error", (error) => child.stdin.destroy(error));
      stream.pipe(child.stdin);
    } else child.stdin.end(options.input);
  });
}
