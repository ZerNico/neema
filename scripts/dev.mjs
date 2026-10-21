import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { instanceEnv, instancePaths, loadInstance, publicOrigin } from "./dev-state.mjs";
import {
  assertIdle,
  checkMigrations,
  connect,
  compose,
  importSnapshot,
  instanceGroups,
  managedDatabases,
  runImportCommand,
  sourceConfig,
  tagCheckout,
} from "./dev-import.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const command = process.argv[2];
const adminUrl = "postgres://chat_dev_admin:local-development-only@127.0.0.1:5433/postgres";
let stopping = false;
let importing = false;
const children = new Set();

function stop(signal = "SIGTERM") {
  stopping = true;
  for (const child of children) {
    try {
      if (process.platform === "win32" || child.direct) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop());

function run(executable, args, options = {}) {
  if (stopping) throw new Error("Development command stopped.");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: [options.input ? "pipe" : "inherit", "inherit", "inherit"],
      detached: process.platform !== "win32",
    });
    child.direct = options.direct === true;
    children.add(child);
    child.once("error", (error) => {
      children.delete(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      children.delete(child);
      if (code === 0 || stopping) resolve();
      else reject(new Error(`${executable} exited with ${signal ?? code}`));
    });
    if (options.input) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });
}

async function prompt(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

async function checkReady(instance, { warnOnPendingMigrations = false } = {}) {
  let client;
  try {
    client = await connect(instanceEnv(instance).DATABASE_URL);
  } catch {
    throw new Error(
      "The isolated development database is unavailable. Run pnpm dev:setup in this checkout first.",
    );
  }
  try {
    await checkMigrations(client);
    if (warnOnPendingMigrations) {
      const local = new Set(
        (await readdir(join(root, "apps/web/drizzle"))).filter((name) => /^\d{14}_/.test(name)),
      );
      const { rows } = await client.query("SELECT name FROM drizzle.__drizzle_migrations");
      if ([...local].some((name) => !rows.some((row) => row.name === name))) {
        console.warn(
          "Development database has pending migrations. Run pnpm dev:setup before relying on new schema.",
        );
      }
    }
  } finally {
    await client.end();
  }
}

async function withIdleDatabase(instance, action) {
  await checkReady(instance);
  const admin = await connect(adminUrl);
  try {
    await assertIdle(admin, instance);
    return await action(instance, admin);
  } finally {
    await admin.end();
  }
}

async function setup(instance, seed) {
  // Resolve the source before provisioning so an unusable one fails before any work.
  const source = seed ? await sourceConfig(root) : null;
  if (source) {
    const sourceClient = await connect(source.url, true).catch(() => {
      throw new Error(
        "The primary development source is unavailable. Run pnpm dev:setup in the primary checkout first.",
      );
    });
    await sourceClient.end();
  }
  // Quiet: the spinner redraws a line per frame, burying what setup prints after it.
  await run("docker", [...compose, "--progress", "quiet", "up", "--detach", "--wait"]);
  const role = `chat_dev_${instance.id}`;
  await run(
    "docker",
    [
      ...compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "chat_dev_admin",
      "-d",
      "postgres",
      "--quiet",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: `SELECT 'CREATE ROLE ${role} LOGIN PASSWORD ''${instance.databasePassword}'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}')\\gexec
SELECT 'CREATE DATABASE ${instance.database} OWNER ${role}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${instance.database}')\\gexec
REVOKE ALL ON DATABASE ${instance.database} FROM PUBLIC;
\\connect ${instance.database}
SET client_min_messages = warning;
CREATE EXTENSION IF NOT EXISTS vector;
`,
    },
  );
  await run("pnpm", ["--filter", "@chat/web", "db:migrate"], { env: instanceEnv(instance) });
  const admin = await connect(adminUrl);
  try {
    for (const database of await managedDatabases(admin, instance)) {
      await tagCheckout(admin, database, instance.root);
    }
  } finally {
    await admin.end();
  }
  if (source) {
    importing = true;
    return withIdleDatabase(instance, (current) =>
      importSnapshot(current, source, runImportCommand),
    );
  }
  // drizzle-kit leaves its last line open.
  console.log(
    `\nReady: ${instance.database}\nState: ${instance.directory}\nRun pnpm dev or pnpm dev:web.\nIn a worktree, copy the primary checkout with pnpm dev:setup --seed or pnpm dev:import.`,
  );
}

// Tagged path gone, or now belonging to a different checkout, means nothing can reach this again.
async function orphanGroups(admin) {
  const groups = await instanceGroups(admin);
  const untagged = groups.filter((group) => !group.checkout);
  const tagged = groups.filter((group) => group.checkout);
  const live = await Promise.all(
    tagged.map((group) =>
      realpath(group.checkout)
        .then((path) => instancePaths(path).id === group.id)
        .catch(() => false),
    ),
  );
  return { untagged, dead: tagged.filter((_, index) => !live[index]) };
}

async function destroyOrphans() {
  if (!process.stdin.isTTY)
    throw new Error("Run pnpm dev:destroy --orphans in a terminal to confirm removing state.");
  const admin = await connect(adminUrl).catch(() => {
    throw new Error(
      "The dedicated development database is unavailable. Run pnpm dev:setup in this checkout first.",
    );
  });
  try {
    const { untagged, dead } = await orphanGroups(admin);
    for (const group of untagged) {
      console.log(
        `Unknown origin, left alone: ${group.databases.join(", ")}\n  Run pnpm dev:setup in its checkout to record the path, or pnpm dev:destroy there.`,
      );
    }
    if (dead.length === 0) {
      console.log("No orphaned development databases.");
      return;
    }
    for (const group of dead) {
      console.log(`Orphan: ${group.databases.join(", ")}\n  Checkout gone: ${group.checkout}`);
    }
    for (const group of dead) {
      for (const database of group.databases) await assertIdle(admin, { database });
    }
    const answer = await prompt(
      `Drop ${dead.length} orphaned instance${dead.length === 1 ? "" : "s"}? [y/N] `,
    );
    if (answer.trim().toLowerCase() !== "y") return;
    for (const group of dead) {
      for (const database of group.databases) await admin.query(`DROP DATABASE ${database}`);
      await admin.query(`DROP ROLE IF EXISTS chat_dev_${group.id}`);
    }
    console.log(`Dropped ${dead.length} orphaned instance${dead.length === 1 ? "" : "s"}.`);
  } finally {
    await admin.end();
  }
}

async function staleSnapshots() {
  const admin = await connect(adminUrl).catch(() => null);
  if (!admin) return [];
  try {
    const current = await loadInstance(root);
    return (await managedDatabases(admin, current)).filter(
      (database) => database !== current.database,
    );
  } finally {
    await admin.end();
  }
}

async function destroy(instance) {
  if (!process.stdin.isTTY)
    throw new Error(
      "Run pnpm dev:destroy in a terminal to confirm removing this checkout’s state.",
    );
  const admin = await connect(adminUrl).catch(() => {
    throw new Error(
      "The dedicated development database is unavailable. Run pnpm dev:setup in this checkout first.",
    );
  });
  try {
    const databases = await managedDatabases(admin, instance);
    for (const database of databases) await assertIdle(admin, { ...instance, database });
    const answer = await prompt(
      `Destroy ${instance.database} and this checkout’s isolated state? [y/N] `,
    );
    if (answer.trim().toLowerCase() !== "y") return;
    for (const database of databases) await admin.query(`DROP DATABASE ${database}`);
    await admin.query(`DROP ROLE IF EXISTS chat_dev_${instance.id}`);
    await rm(instancePaths(instance.root).directory, { recursive: true, force: true });
    console.log(`Destroyed ${instance.database} and this checkout’s isolated state.`);
  } finally {
    await admin.end();
  }
}

async function desktop(instance) {
  await checkReady(instance, { warnOnPendingMigrations: true });
  const origin = await readFile(instance.origin, "utf8").catch(() => null);
  if (!origin) throw new Error("Start pnpm dev:web first so desktop has a Portless origin.");
  await mkdir(instance.profile, { recursive: true });
  await run(process.execPath, ["dev.mjs"], {
    cwd: join(root, "apps/desktop"),
    direct: true,
    env: { ...instanceEnv(instance), CHAT_DESKTOP_SERVER: publicOrigin(origin) },
  });
}

async function serve(instance, mode) {
  if (!process.env.PORTLESS_URL || !/^\d+$/.test(process.env.PORT ?? "")) {
    throw new Error("The server must be launched through Portless.");
  }
  await checkReady(instance, { warnOnPendingMigrations: true });
  const origin = publicOrigin(process.env.PORTLESS_URL);
  await mkdir(instance.profile, { recursive: true });
  await writeFile(instance.origin, origin);
  console.log(`Chat: ${origin}\nDatabase: ${instance.database}\nState: ${instance.directory}`);
  const env = { ...instanceEnv(instance), PUBLIC_URL: origin, CHAT_DESKTOP_SERVER: origin };
  const require = createRequire(join(root, "apps/web/package.json"));
  const vite = join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
  const tasks = [
    run(process.execPath, [vite, "dev"], { cwd: join(root, "apps/web"), env, direct: true }),
  ];
  if (mode === "all")
    tasks.push(
      run(process.execPath, ["dev.mjs"], { cwd: join(root, "apps/desktop"), env, direct: true }),
    );
  const results = await Promise.allSettled(tasks.map((task) => task.finally(() => stop())));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function main() {
  const commands = new Set([
    "setup",
    "info",
    "import",
    "destroy",
    "all",
    "web",
    "desktop",
    "serve",
    "migrate",
    "push",
    "studio",
  ]);
  if (!commands.has(command)) {
    throw new Error(
      "Use pnpm dev:setup, dev, dev:web, dev:desktop, dev:info, dev:import, dev:destroy or db:migrate/push/studio.",
    );
  }
  const options = { setup: ["--seed"], destroy: ["--orphans"] }[command];
  const flags = options ? process.argv.slice(3) : [];
  const unknown = flags.find((flag) => !options.includes(flag));
  if (unknown || flags.length > 1)
    throw new Error(
      `Use ${command}${options.length ? ` ${options[0]}` : ""} without other options.`,
    );
  if (command === "destroy" && flags.includes("--orphans")) return destroyOrphans();
  const instance = await loadInstance(root, command === "setup");
  if (command === "setup") return setup(instance, flags.includes("--seed"));
  if (command === "info") {
    const origin = await readFile(instance.origin, "utf8").catch(() => "Not started yet");
    const stale = await staleSnapshots();
    console.log(
      `URL (last launch): ${origin}\nDatabase: ${instance.database} on 127.0.0.1:5433\nBlobs: ${instance.blobs}\nDesktop: ${instance.profile}${stale.length ? `\nStale snapshots: ${stale.join(", ")}` : ""}`,
    );
    return;
  }
  if (command === "destroy") return destroy(instance);
  if (command === "import") {
    if (!process.stdin.isTTY)
      throw new Error("Run pnpm dev:import in a terminal to confirm replacing dev state.");
    const source = await sourceConfig(root);
    const answer = await prompt(
      "Replace this checkout’s dev state with personal data and provider credentials? [y/N] ",
    );
    if (answer.trim().toLowerCase() !== "y") return;
    importing = true;
    return withIdleDatabase(instance, (current) =>
      importSnapshot(current, source, runImportCommand),
    );
  }
  // Drizzle applies pending migrations in one transaction, so a running server is fine.
  // Push diffs the schema interactively and may drop columns, so it still wants quiet.
  if (command === "migrate") {
    await checkReady(instance);
    return run("pnpm", ["--filter", "@chat/web", "db:migrate"], { env: instanceEnv(instance) });
  }
  if (command === "push") {
    return withIdleDatabase(instance, (current) =>
      run("pnpm", ["--filter", "@chat/web", "db:push"], { env: instanceEnv(current) }),
    );
  }
  if (command === "studio") {
    await checkReady(instance);
    return run("pnpm", ["--filter", "@chat/web", "db:studio"], { env: instanceEnv(instance) });
  }
  if (command === "desktop") return desktop(instance);
  if (command !== "serve") {
    try {
      return await run("pnpm", [
        "exec",
        "portless",
        "run",
        "--name",
        "chat",
        "node",
        "scripts/dev.mjs",
        "serve",
        command,
      ]);
    } catch (error) {
      throw new Error(
        `${error.message}\nRun pnpm exec portless doctor. If needed, run pnpm exec portless proxy start --port 1355 --https.`,
        { cause: error },
      );
    }
  }
  return serve(instance, process.argv[3]);
}

main().catch((error) => {
  // On a line of its own: a child's spinner may have left the cursor mid-line.
  console.error(
    "\n" +
      (importing && !error.safe
        ? "Snapshot import failed; current state retained. Check source configuration and database availability; connection details suppressed."
        : error.message),
  );
  process.exitCode = 1;
});
