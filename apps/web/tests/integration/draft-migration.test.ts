import { PgClient } from "@effect/sql-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conversationDrafts } from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

/** The migration that renames the agent-draft table into the generic store. */
const GENERIC_DRAFTS = "20260918203923_blue_magma";
const root = new URL("../..", import.meta.url).pathname;

let container: StartedPostgreSqlContainer;
let runtime: ManagedRuntime.ManagedRuntime<Db, unknown>;
let url: string;

// drizzle-kit reads one folder; a copy without this migration and all later
// ones (which may build on it) is the database before this change shipped. The config names
// the folder, so each run gets a throwaway config pointing at its copy.
const migrateTo = (folder: string) => {
  const config = join(folder, "drizzle.config.ts");
  writeFileSync(
    config,
    `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: ${JSON.stringify(join(root, "src/db/schema/index.ts"))},
  out: ${JSON.stringify(folder)},
  dbCredentials: { url: process.env.DATABASE_URL! },
});
`,
  );
  execSync(`pnpm drizzle-kit migrate --config ${JSON.stringify(config)}`, {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  url = container.getConnectionUri();
  runtime = ManagedRuntime.make(
    Db.layer.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 2 })),
    ),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});

describe("agent drafts migrate onto the generic draft store", () => {
  it("keeps an existing agent draft, its target and its receipt, as kind 'agent'", async () => {
    const before = mkdtempSync(join(tmpdir(), "drizzle-before-"));
    try {
      cpSync(join(root, "drizzle"), before, { recursive: true });
      // Folder names start with their timestamp, so they sort in apply order.
      for (const name of readdirSync(before))
        if (name >= GENERIC_DRAFTS && name !== "meta")
          rmSync(join(before, name), { recursive: true });
      expect(readdirSync(before)).not.toContain(GENERIC_DRAFTS);
      migrateTo(before);
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.execute(
            `insert into "user" (id, name, email) values ('u1', 'Owner', 'u1@t.io')` as never,
          );
          yield* db.execute(
            `insert into conversations (id, user_id, title) values ('c1', 'u1', 'Chat')` as never,
          );
          yield* db.execute(
            `insert into conversation_agent_drafts
               (id, conversation_id, settings, revision, target_agent_id, target_revision, saved_draft_revision)
             values ('d1', 'c1', '{"name":"Writer","instructions":"Keep it short"}', 3, 'agent-9', 2, 3),
                    ('d2', 'c1', '{"name":"Left behind"}', 1, null, null, null)` as never,
          );
          // d1 was opened by an answer still in the chat; d2's answer was rewound.
          yield* db.execute(
            `insert into messages (id, conversation_id, role) values ('m1', 'c1', 'assistant')` as never,
          );
          yield* db.execute(
            `insert into message_tool_calls
               (id, message_id, turn_index, call_index, provider_call_id, tool_name, arguments, result, status)
             values ('t1', 'm1', 0, 0, 'p1', 'draft_agent', '{}',
                     '{"outcome":"drafted","draftId":"d1","draftConversationId":"c1"}', 'complete')` as never,
          );
        }),
      );
      const after = mkdtempSync(join(tmpdir(), "drizzle-after-"));
      cpSync(join(root, "drizzle"), after, { recursive: true });
      migrateTo(after);
      rmSync(after, { recursive: true, force: true });
      const rows = await runtime.runPromise(
        Effect.flatMap(Db, (db) => db.select().from(conversationDrafts)),
      );
      expect(rows).toEqual([
        expect.objectContaining({
          id: "d1",
          conversationId: "c1",
          kind: "agent",
          settings: { name: "Writer", instructions: "Keep it short" },
          revision: 3,
          targetId: "agent-9",
          targetRevision: 2,
          savedDraftRevision: 3,
          createdByMessageId: "m1",
        }),
      ]);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  }, 180_000);
});
