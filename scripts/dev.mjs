import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { instanceEnv, loadInstance, publicOrigin } from "./dev-state.mjs";
import { registerRuntime, runtimeRequest, withMaintenance } from "./dev-lifecycle.mjs";
import { assertIdle, connect, compose, importSnapshot, runImportCommand, sourceConfig } from "./dev-import.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const command = process.argv[2];
let stopping = false;
const children = new Set();
function stop(signal = "SIGTERM") {
  stopping = true;
  for (const child of children) {
    try {
      if (process.platform === "win32" || child.direct) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
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
    child.once("error", (error) => { children.delete(child); reject(error); });
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

async function supervised(instance, slot, action, origin = null) {
  const close = await registerRuntime(instance, slot, () => stop(), origin);
  try {
    // The slot now prevents activation, so this cannot start a stale generation.
    const current = await loadInstance(root);
    if (!stopping) await action(current);
  } finally { await close(); }
}

async function maintenance(instance, action) {
  return withMaintenance(instance, async () => {
    const current = await loadInstance(root);
    const admin = await connect("postgres://chat_dev_admin:local-development-only@127.0.0.1:5433/postgres");
    try { await assertIdle(admin, current); } finally { await admin.end(); }
    if (stopping) throw new Error("Development command stopped.");
    return action(current);
  });
}

async function main() {
  if (!["setup", "info", "stop", "import", "all", "web", "desktop", "serve", "migrate", "push", "studio"].includes(command)) {
    throw new Error("Use pnpm dev:setup, dev, dev:web, dev:desktop, dev:info, dev:stop, dev:import or db:migrate/push/studio.");
  }
  const instance = await loadInstance(root, command === "setup");
  if (command === "stop") {
    for (const slot of ["desktop", "web"]) {
      const result = await runtimeRequest(instance, slot, "stop");
      console.log(result ? `${slot}: stopped.` : `${slot}: no registered runtime (older or direct package runners must be stopped in their own terminal).`);
    }
    return;
  }
  if (command === "import") {
    if (!process.stdin.isTTY) throw new Error("Run pnpm dev:import in a terminal to confirm replacing dev state.");
    const source = await sourceConfig(root);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await prompt.question("Replace this checkout’s dev state with personal data and provider credentials? [y/N] "); }
    finally { prompt.close(); }
    if (answer.trim().toLowerCase() !== "y") return;
    await maintenance(instance, (current) => importSnapshot(current, source, runImportCommand));
    return;
  }
  if (command === "setup") {
    await run("docker", [...compose, "up", "--detach", "--wait"]);
    return maintenance(instance, async (current) => {
      const role = `chat_dev_${current.id}`;
      await run("docker", [...compose, "exec", "-T", "postgres", "psql", "-U", "chat_dev_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
        input: `SELECT pg_advisory_lock(5433);
SELECT 'CREATE ROLE ${role} LOGIN PASSWORD ''${current.databasePassword}'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}')\\gexec
SELECT 'CREATE DATABASE ${current.database} OWNER ${role}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${current.database}')\\gexec
REVOKE ALL ON DATABASE ${current.database} FROM PUBLIC;
\\connect ${current.database}
CREATE EXTENSION IF NOT EXISTS vector;
`,
      });
      await run("pnpm", ["--filter", "@chat/web", "db:migrate"], { env: instanceEnv(current) });
      console.log(`Ready: ${current.database}\nState: ${current.directory}\nRun pnpm dev or pnpm dev:web.\nCopy personal data with pnpm dev:import, or register normally on a fresh database.`);
    });
  }
  if (command === "info") {
    const origin = await readFile(instance.origin, "utf8").catch(() => "Not started yet");
    for (const slot of ["web", "desktop"]) {
      const runtime = await runtimeRequest(instance, slot);
      console.log(`${slot}: ${runtime ? `running (runner ${runtime.pid})` : "no registered runtime"}`);
    }
    console.log(`URL (last launch): ${origin}\nDatabase: ${instance.database} on 127.0.0.1:5433\nBlobs: ${instance.blobs}\nDesktop: ${instance.profile}`);
    return;
  }
  if (["migrate", "push", "studio"].includes(command)) {
    return maintenance(instance, (current) => run("pnpm", ["--filter", "@chat/web", `db:${command}`], { env: instanceEnv(current) }));
  }
  if (command === "desktop") {
    return supervised(instance, "desktop", async (current) => {
      const web = await runtimeRequest(current, "web");
      if (!web?.origin || web.database !== current.database) throw new Error("Start pnpm dev:web first so desktop uses its live Portless origin.");
      await mkdir(current.profile, { recursive: true });
      await run(process.execPath, ["dev.mjs"], {
        cwd: join(root, "apps/desktop"), direct: true,
        env: { ...instanceEnv(current), CHAT_DESKTOP_SERVER: publicOrigin(web.origin) },
      });
    });
  }
  if (command !== "serve") {
    // Portless assigns the route; the inner runner owns the runtime lock.
    await run("pnpm", ["exec", "portless", "run", "--name", "chat", "node", "scripts/dev.mjs", "serve", command]);
    return;
  }
  if (!process.env.PORTLESS_URL || !/^\d+$/.test(process.env.PORT ?? "")) throw new Error("The server must be launched through Portless.");
  const origin = publicOrigin(process.env.PORTLESS_URL);
  return supervised(instance, "web", async (current) => {
    const serve = async () => {
      await mkdir(current.profile, { recursive: true });
      await writeFile(current.origin, origin);
      console.log(`Chat: ${origin}\nDatabase: ${current.database}\nState: ${current.directory}`);
      const env = { ...instanceEnv(current), BETTER_AUTH_URL: origin, CHAT_DESKTOP_SERVER: origin };
      const require = createRequire(join(root, "apps/web/package.json"));
      const vite = join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
      const tasks = [run(process.execPath, [vite, "dev"], { cwd: join(root, "apps/web"), env, direct: true })];
      if (process.argv[3] === "all") tasks.push(run(process.execPath, ["dev.mjs"], { cwd: join(root, "apps/desktop"), env, direct: true }));
      // Either app exiting retires its sibling; keep both locks until both children close.
      const results = await Promise.allSettled(tasks.map((task) => task.finally(() => stop())));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    };
    if (process.argv[3] === "all") await supervised(current, "desktop", serve, origin);
    else await serve();
  }, origin);
}

main().catch((error) => {
  console.error(command === "import" && !error.safe ? "Snapshot import failed; previous state retained. Check source configuration and database availability; connection details suppressed." : error.message);
  process.exitCode = 1;
});
