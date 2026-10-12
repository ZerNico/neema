import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./database.ts";

const exec = promisify(execFile);
let database: TestDatabase;
let client: Client;

beforeAll(async () => {
  database = await createTestDatabase();
  client = new Client({ connectionString: database.url });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
});

it("holds imported automation without deleting its saved work or configuration", async () => {
  await client.query(`
    INSERT INTO "user" (id, name, email) VALUES ('owner', 'Owner', 'owner@import.test');
    INSERT INTO account (id, user_id, account_id, provider_id, password)
      VALUES ('password', 'owner', 'owner', 'credential', 'synthetic-password-hash');
    INSERT INTO session (id, user_id, token, expires_at)
      VALUES ('device', 'owner', 'synthetic-session-token', now() + interval '1 hour');
    INSERT INTO conversations (id, user_id) VALUES ('chat', 'owner');
    INSERT INTO conversation_queue_entries (id, conversation_id, user_id, content, input)
      VALUES ('queued', 'chat', 'owner', 'Keep this draft', '{}');
    INSERT INTO schedules (id, user_id, name, prompt, schedule_text, cron, timezone, next_fire_at)
      VALUES ('schedule', 'owner', 'Digest', 'Keep this prompt', 'hourly', '0 * * * *', 'UTC', now());
    INSERT INTO schedule_runs (id, schedule_id, status) VALUES
      ('pending', 'schedule', 'pending'), ('started', 'schedule', 'started'),
      ('error', 'schedule', 'error');
    INSERT INTO notification_settings (user_id, email) VALUES ('owner', true);
  `);

  for (let attempt = 0; attempt < 2; attempt++) {
    // Exercise the real script without importing untyped operational helpers into web code.
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { connect, sanitize } from './scripts/dev-import.mjs';
      const client = await connect(process.env.TEST_IMPORT_URL);
      try { await sanitize(client); } finally { await client.end(); }
    `,
      ],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        env: { ...process.env, TEST_IMPORT_URL: database.url },
      },
    );
  }

  expect((await client.query("SELECT id FROM session")).rows).toEqual([]);
  expect((await client.query("SELECT password FROM account")).rows).toEqual([
    { password: "synthetic-password-hash" },
  ]);
  expect((await client.query("SELECT prompt, paused, next_fire_at FROM schedules")).rows).toEqual([
    { prompt: "Keep this prompt", paused: true, next_fire_at: null },
  ]);
  expect(
    (
      await client.query(
        "SELECT id, status, settled_at IS NOT NULL AS settled FROM schedule_runs ORDER BY id",
      )
    ).rows,
  ).toEqual([
    { id: "error", status: "error", settled: true },
    { id: "pending", status: "skipped", settled: true },
    { id: "started", status: "skipped", settled: true },
  ]);
  expect(
    (await client.query("SELECT content, last_error FROM conversation_queue_entries")).rows,
  ).toEqual([
    {
      content: "Keep this draft",
      last_error: "Imported message. Send now or edit it to continue.",
    },
  ]);
  expect((await client.query("SELECT email FROM notification_settings")).rows).toEqual([
    { email: false },
  ]);
});
