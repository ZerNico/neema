import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { instanceEnv, instancePaths, loadInstance, publicOrigin } from "./dev-state.mjs";

async function checkout(t) {
  const root = await mkdtemp(join(tmpdir(), "chat-dev-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("checkout paths are stable and isolated, including SQL identifiers", () => {
  const first = instancePaths("/repo/main");
  assert.deepEqual(instancePaths("/repo/main"), first);
  const second = instancePaths("/repo/worktree'; DROP DATABASE postgres;");
  assert.notEqual(first.database, second.database);
  assert.notEqual(first.blobs, second.blobs);
  assert.notEqual(first.profile, second.profile);
  assert.match(second.database, /^chat_dev_[a-f0-9]{16}$/);
});

test("setup preserves secrets across reruns and concurrent setup", async (t) => {
  const root = await checkout(t);
  const [first, second] = await Promise.all([loadInstance(root, true), loadInstance(root, true)]);
  assert.deepEqual(first, second);
  assert.deepEqual(await loadInstance(root, true), first);
  assert.equal((await stat(first.config)).mode & 0o777, 0o600);
  assert.equal(Buffer.from(first.providerSecret, "base64").length, 32);
});

test("missing setup fails rather than inheriting a personal database", async (t) => {
  await assert.rejects(loadInstance(await checkout(t)), /dev:setup/);
});

test("generated configuration overrides inherited targets without reading .env", async (t) => {
  const root = await checkout(t);
  const envFile = join(root, ".env");
  await writeFile(envFile, "DATABASE_URL=postgres://personal/real\n");
  const instance = await loadInstance(root, true);
  const env = instanceEnv(instance, {
    DATABASE_URL: "postgres://personal/real",
    PROVIDER_KEY_SECRET: "personal-key",
    BLOB_STORE_ROOT: "/personal/blobs",
    CHAT_DESKTOP_PROFILE: "/personal/profile",
    PATH: "/bin",
  });
  const url = new URL(env.DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "5433");
  assert.equal(url.pathname, `/${instance.database}`);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.PROVIDER_KEY_SECRET, instance.providerSecret);
  assert.equal(env.BLOB_STORE_ROOT, instance.blobs);
  assert.equal(env.CHAT_DESKTOP_PROFILE, instance.profile);
  assert.equal(await readFile(envFile, "utf8"), "DATABASE_URL=postgres://personal/real\n");
});

test("copied state and malformed passwords are refused", async (t) => {
  const first = await loadInstance(await checkout(t), true);
  const second = await loadInstance(await checkout(t), true);
  await writeFile(second.config, await readFile(first.config));
  await assert.rejects(loadInstance(second.root), /Invalid dev instance/);
  const config = JSON.parse(await readFile(first.config, "utf8"));
  config.databasePassword = "' unsafe";
  await writeFile(first.config, JSON.stringify(config));
  await assert.rejects(loadInstance(first.root), /Invalid dev instance/);
});

test("public origins retain HTTPS and reject non-web or credentialed URLs", () => {
  assert.equal(publicOrigin("https://fix-ui.chat.localhost/path"), "https://fix-ui.chat.localhost");
  assert.throws(() => publicOrigin("file:///tmp/app"));
  assert.throws(() => publicOrigin("https://user:secret@chat.localhost"));
});
