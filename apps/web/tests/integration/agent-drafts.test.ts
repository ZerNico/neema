import { PgClient } from "@effect/sql-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  conversationAgentDrafts,
  conversations,
  knowledgeCollections,
  messages,
  researchRuns,
  skills,
  user,
} from "~/db/schema/index.ts";
import {
  EMPTY_AGENT_DRAFT,
  type AgentDraft,
  type AgentDraftPatch,
} from "~/modules/agents/draft-schema.ts";
import { AgentDraftRepo } from "~/modules/agents/server/draft-repo.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { AgentService } from "~/modules/agents/server/service.ts";
import { lockGeneration } from "~/modules/chat/server/generation-fence.ts";
import { initialResearchProgress, lockResearchFence } from "~/modules/chat/server/research/repo.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { SyncEvent } from "~/modules/sync/events.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 9).toString("base64");
let container: StartedPostgreSqlContainer;
type Services = Db | AgentDraftRepo | AgentDraftService | AgentRepo | AgentService;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
const events: Array<{ userId: string | null; event: SyncEvent }> = [];
let publishingFails = false;
const TestBus = Layer.succeed(SyncBus, {
  publish: (userId, event) =>
    Effect.sync(() => {
      if (publishingFails) throw new Error("notification unavailable");
      events.push({ userId, event });
    }),
  publishGlobal: (event) =>
    Effect.sync(() => {
      if (publishingFails) throw new Error("notification unavailable");
      events.push({ userId: null, event });
    }),
  signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
  subscribe: () => Stream.empty,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  const infrastructure = Layer.mergeAll(Db.layer, KeyCipher.layer).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
  );
  const core = Layer.mergeAll(
    AgentRepo.layer,
    AgentDraftRepo.layer,
    KnowledgeRepo.layer,
    ProviderRepo.layer,
    TestBus,
  ).pipe(Layer.provideMerge(infrastructure));
  runtime = ManagedRuntime.make(
    Layer.mergeAll(AgentDraftService.layer, AgentService.layer).pipe(Layer.provideMerge(core)),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});
beforeEach(() => {
  events.length = 0;
  publishingFails = false;
});

const createUser = () =>
  run(
    Effect.gen(function* () {
      const id = uuidv7();
      yield* (yield* Db).insert(user).values({ id, name: "Draft owner", email: `${id}@t.io` });
      return id;
    }),
  );
const initialize = (userId: string, targetAgentId: string | null = null) =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const drafts = yield* AgentDraftRepo;
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const conversationId = uuidv7();
          yield* tx.insert(conversations).values({ id: conversationId, userId });
          return yield* drafts.initialize(tx, userId, conversationId, targetAgentId);
        }),
      );
    }),
  );
const get = (userId: string, draft: AgentDraft) =>
  run(Effect.flatMap(AgentDraftService, (service) => service.get(userId, draft.id)));
const patch = (userId: string, draft: AgentDraft, changes: AgentDraftPatch) =>
  run(
    Effect.flatMap(AgentDraftService, (service) =>
      service.patch(userId, {
        draftId: draft.id,
        expectedRevision: draft.revision,
        changes,
      }),
    ),
  );
const save = (userId: string, draft: AgentDraft) =>
  run(
    Effect.flatMap(AgentDraftService, (service) =>
      service.save(userId, {
        draftId: draft.id,
        expectedRevision: draft.revision,
      }),
    ),
  );
const reload = (userId: string, draft: AgentDraft) =>
  run(
    Effect.flatMap(AgentDraftService, (service) =>
      service.reload(userId, {
        draftId: draft.id,
        expectedRevision: draft.revision,
      }),
    ),
  );
const createAgent = (userId: string, name = "Original") =>
  run(
    Effect.flatMap(AgentService, (service) =>
      service.create(userId, {
        ...EMPTY_AGENT_DRAFT,
        name,
        instructions: "Original instructions",
      }),
    ),
  );
const loadAgent = (userId: string, agentId: string) =>
  run(Effect.flatMap(AgentRepo, (repo) => repo.get(userId, agentId)));
const countAgents = (userId: string) =>
  run(
    Effect.gen(function* () {
      const [row] = yield* (yield* Db)
        .select({ value: sql<number>`count(*)::int` })
        .from(agents)
        .where(eq(agents.userId, userId));
      return row!.value;
    }),
  );

const generation = (userId: string, draft: Pick<AgentDraft, "conversationId">) =>
  run(
    Effect.gen(function* () {
      const fence = {
        userId,
        conversationId: draft.conversationId,
        messageId: uuidv7(),
        generationId: uuidv7(),
      };
      yield* (yield* Db).insert(messages).values({
        id: fence.messageId,
        conversationId: fence.conversationId,
        generationId: fence.generationId,
        role: "assistant",
        status: "streaming",
      });
      return fence;
    }),
  );
/** The conversation's first draft, for assertions that follow a fenced write. */
const draftOf = (userId: string, conversationId: string) =>
  Effect.flatMap(AgentDraftService, (service) =>
    Effect.map(service.list(userId, conversationId), (drafts) => drafts[0] ?? null),
  );
const interrupted = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
};
const controller = async () => {
  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  return { client, pid: rows[0]!.pid };
};
const waitForBlocked = async (client: Client, blocker?: number) => {
  await expect
    .poll(async () => {
      const { rows } = await client.query<{ count: number }>(
        blocker === undefined
          ? "select count(*)::int as count from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0"
          : "select count(*)::int as count from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))",
        blocker === undefined ? [] : [blocker],
      );
      return rows[0]!.count;
    })
    .toBeGreaterThan(0);
};

describe("tool-created agent drafts", () => {
  const ordinary = async (owner: string) => {
    const conversationId = uuidv7();
    await run(
      Effect.flatMap(Db, (db) =>
        db.insert(conversations).values({ id: conversationId, userId: owner }),
      ),
    );
    return generation(owner, { conversationId });
  };

  const open = (
    owner: string,
    fence: Parameters<typeof lockGeneration>[1],
    input: { agentId?: string; changes?: AgentDraftPatch } = {},
  ) =>
    run(
      Effect.flatMap(AgentDraftService, (service) =>
        service.open(owner, { conversationId: fence.conversationId, ...input }, (tx) =>
          lockGeneration(tx, fence),
        ),
      ),
    );

  it("reuses an empty unedited draft so a repeated call cannot litter the chat", async () => {
    const owner = await createUser();
    const fence = await ordinary(owner);
    const results = await Promise.all([open(owner, fence), open(owner, fence)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["drafted", "read"]);
    expect(results[0]!.draft).toEqual(results[1]!.draft);
    expect(results[0]!.draft.revision).toBe(1);
    expect(await countAgents(owner)).toBe(0);
    expect(events.filter(({ event }) => event.type === "agent.draft.changed")).toHaveLength(1);
  });

  it("starts a second draft once the first carries anything at all", async () => {
    const owner = await createUser();
    const fence = await ordinary(owner);
    // Named at creation: content, so the next open is a genuine second agent.
    const first = (await open(owner, fence, { changes: { name: "Jira tickets" } })).draft;
    const edited = (await patch(owner, first, { instructions: "Be precise." })).draft;
    const second = await open(owner, fence, { changes: { name: "Release notes" } });
    expect(second.outcome).toBe("drafted");
    expect(second.draft.id).not.toBe(first.id);
    // The reported defect: the second agent must not land on the first draft.
    expect(second.draft.settings).toMatchObject({ name: "Release notes", instructions: "" });
    expect(await get(owner, edited)).toMatchObject({
      settings: { name: "Jira tickets", instructions: "Be precise." },
    });
    const drafts = await run(
      Effect.flatMap(AgentDraftService, (service) => service.list(owner, fence.conversationId)),
    );
    expect(drafts.map((draft) => draft.id)).toEqual([first.id, second.draft.id].sort());
  });

  it("keeps two drafts of the same chat independent through save and discard", async () => {
    const owner = await createUser();
    const fence = await ordinary(owner);
    const first = (await open(owner, fence, { changes: { name: "First agent" } })).draft;
    const second = (await open(owner, fence, { changes: { name: "Second agent" } })).draft;
    expect(second.id).not.toBe(first.id);
    const saved = await save(owner, first);
    if (saved.outcome !== "saved") throw new Error("expected saved");
    // Saving one draft must not move the other's target or revision.
    expect(await get(owner, second)).toMatchObject({
      settings: { name: "Second agent" },
      targetAgentId: null,
      savedDraftRevision: null,
      revision: second.revision,
    });
    expect(await countAgents(owner)).toBe(1);
    const secondSaved = await save(owner, second);
    if (secondSaved.outcome !== "saved") throw new Error("expected saved");
    expect(secondSaved.agentId).not.toBe(saved.agentId);
    expect(await countAgents(owner)).toBe(2);
    await run(Effect.flatMap(AgentDraftService, (service) => service.discard(owner, second.id)));
    expect(await get(owner, second)).toBeNull();
    expect(await get(owner, first)).not.toBeNull();
    // Discarding a draft never touches the agent it was saved to.
    expect(await countAgents(owner)).toBe(2);
  });

  it("reopens the draft already holding a target rather than making a rival for it", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const otherId = await createAgent(owner, "Another agent");
    const fence = await ordinary(owner);
    const opened = await open(owner, fence, {
      agentId,
      changes: { name: "Working name", starters: [] },
    });
    expect(opened).toMatchObject({
      outcome: "drafted",
      draft: {
        revision: 1,
        targetAgentId: agentId,
        targetRevision: 1,
        settings: { name: "Working name", instructions: "Original instructions", starters: [] },
      },
    });
    expect((await loadAgent(owner, agentId))!.row).toMatchObject({
      name: "Original",
      configRevision: 1,
    });
    // Same target: the existing draft, with its changes untouched.
    expect(
      await open(owner, fence, { agentId, changes: { instructions: "Do not replace" } }),
    ).toEqual({
      outcome: "read",
      draft: opened.draft,
    });
    // Different target: its own draft, snapshotting that agent.
    const other = await open(owner, fence, { agentId: otherId });
    expect(other.outcome).toBe("drafted");
    expect(other.draft.targetAgentId).toBe(otherId);
    expect(other.draft.id).not.toBe(opened.draft.id);
  });

  it("refuses a shared target and a different conversation owner without creating a draft", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agentId = await createAgent(stranger);
    await run(
      Effect.flatMap(Db, (db) =>
        db.update(agents).set({ audience: "instance" }).where(eq(agents.id, agentId)),
      ),
    );
    const fence = await ordinary(owner);
    for (const [userId, target] of [
      [owner, agentId],
      [stranger, undefined],
    ] as const) {
      await expect(
        run(
          Effect.flatMap(AgentDraftService, (service) =>
            service.open(
              userId,
              {
                conversationId: fence.conversationId,
                ...(target ? { agentId: target } : {}),
              },
              (tx) => lockGeneration(tx, fence),
            ),
          ),
        ),
      ).rejects.toThrow();
    }
    expect(await run(draftOf(owner, fence.conversationId))).toBeNull();
  });

  it.each(["stopped", "replaced", "owner"] as const)(
    "refuses lazy creation after the generation is %s",
    async (state) => {
      const owner = await createUser();
      const fence = await ordinary(owner);
      let currentOwner = owner;
      if (state === "owner") {
        currentOwner = await createUser();
        await run(
          Effect.flatMap(Db, (db) =>
            db
              .update(conversations)
              .set({ userId: currentOwner })
              .where(eq(conversations.id, fence.conversationId)),
          ),
        );
      } else
        await run(
          Effect.flatMap(Db, (db) =>
            db
              .update(messages)
              .set(state === "stopped" ? { status: "aborted" } : { generationId: uuidv7() })
              .where(eq(messages.id, fence.messageId)),
          ),
        );
      interrupted(
        await runtime.runPromiseExit(
          Effect.flatMap(AgentDraftService, (service) =>
            service.open(
              owner,
              {
                conversationId: fence.conversationId,
                changes: { name: "Too late" },
              },
              (tx) => lockGeneration(tx, fence),
            ),
          ),
        ),
      );
      expect(await run(draftOf(currentOwner, fence.conversationId))).toBeNull();
    },
  );
});

describe("persistent agent drafts", () => {
  it("initializes in the caller transaction and reads drafts only for their owner", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const draft = await initialize(owner);
    expect(draft).toMatchObject({
      settings: EMPTY_AGENT_DRAFT,
      revision: 1,
      targetAgentId: null,
      targetRevision: null,
      savedDraftRevision: null,
    });
    expect(await get(owner, draft)).toEqual(draft);
    expect(await get(stranger, draft)).toBeNull();
    const rolledBack = uuidv7();
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentDraftRepo;
        return yield* (yield* Db)
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(conversations).values({ id: rolledBack, userId: owner });
              yield* repo.initialize(tx, owner, rolledBack, null);
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.result);
      }),
    );
    expect(
      await run(
        Effect.flatMap(Db, (db) =>
          db.select().from(conversations).where(eq(conversations.id, rolledBack)),
        ),
      ),
    ).toEqual([]);
  });

  it("permits partial working text, patches only supplied fields, and uses draft CAS", async () => {
    const owner = await createUser();
    const initial = await initialize(owner);
    const first = await patch(owner, initial, { instructions: "Keep this", starters: [""] });
    expect(first.outcome).toBe("updated");
    expect(first.draft.revision).toBe(2);
    expect((await save(owner, first.draft)).outcome).toBe("invalid");
    const next = await patch(owner, first.draft, { description: "Unfinished " });
    expect(next.draft.settings).toMatchObject({
      name: "",
      instructions: "Keep this",
      starters: [""],
      description: "Unfinished ",
    });
    expect(await patch(owner, next.draft, { starters: [""] })).toEqual({
      outcome: "unchanged",
      draft: next.draft,
    });
    expect(await patch(owner, next.draft, {})).toEqual({ outcome: "unchanged", draft: next.draft });
    expect(await patch(owner, first.draft, { name: "Stale" })).toEqual({
      outcome: "conflict",
      draft: next.draft,
    });
    expect((await patch(owner, next.draft, { starters: [] })).draft.settings.starters).toEqual([]);
    expect(await countAgents(owner)).toBe(0);
  });

  it("serializes competing direct changes without merging an obsolete full document", async () => {
    const owner = await createUser();
    const draft = await initialize(owner);
    const results = await Promise.all([
      patch(owner, draft, { name: "A" }),
      patch(owner, draft, { name: "B" }),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["conflict", "updated"]);
    expect(results[0]!.draft).toEqual(results[1]!.draft);
    expect((await get(owner, draft))!.revision).toBe(2);
  });

  it("never exposes an owned target or allows writes through another user’s conversation", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agentId = await createAgent(owner);
    await run(
      Effect.flatMap(Db, (db) =>
        db.update(agents).set({ audience: "instance" }).where(eq(agents.id, agentId)),
      ),
    );
    const draft = await initialize(owner, agentId);
    expect(await get(stranger, draft)).toBeNull();
    await expect(initialize(stranger, agentId)).rejects.toThrow();
    await Promise.all(
      [
        patch(stranger, draft, { name: "Wrong owner" }),
        save(stranger, draft),
        reload(stranger, draft),
      ].map((action) => expect(action).rejects.toThrow()),
    );
    expect((await get(owner, draft))!.settings.instructions).toBe("Original instructions");
    expect((await loadAgent(owner, agentId))!.row.configRevision).toBe(1);
  });

  it("snapshots dependency identities and permits unrelated edits after their access is revoked", async () => {
    const owner = await createUser();
    const resourceOwner = await createUser();
    const collectionId = uuidv7();
    const skillId = uuidv7();
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(knowledgeCollections).values({
          id: collectionId,
          userId: resourceOwner,
          name: "Shared",
          audience: "instance",
        });
        yield* db.insert(skills).values({
          id: skillId,
          userId: resourceOwner,
          name: "Manual skill",
          description: "",
          manualOnly: true,
          audience: "instance",
        });
      }),
    );
    const agentId = await run(
      Effect.flatMap(AgentService, (service) =>
        service.create(owner, {
          ...EMPTY_AGENT_DRAFT,
          name: "Dependencies",
          collectionIds: [collectionId],
          skillIds: [skillId],
        }),
      ),
    );
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db
          .update(knowledgeCollections)
          .set({ audience: "private" })
          .where(eq(knowledgeCollections.id, collectionId));
        yield* db.update(skills).set({ audience: "private" }).where(eq(skills.id, skillId));
      }),
    );
    const draft = await initialize(owner, agentId);
    expect(draft.settings).toMatchObject({ collectionIds: [collectionId], skillIds: [skillId] });
    const edited = (await patch(owner, draft, { description: "Safe working edit" })).draft;
    expect(edited.settings).toMatchObject({ collectionIds: [collectionId], skillIds: [skillId] });
    expect(await save(owner, edited)).toMatchObject({
      outcome: "invalid",
      reason: "a selected skill is unavailable",
      draft: edited,
    });
    const withoutSkill = (await patch(owner, edited, { skillIds: [] })).draft;
    expect(await save(owner, withoutSkill)).toMatchObject({
      outcome: "invalid",
      reason: "a selected collection is unavailable",
    });
    const removed = (await patch(owner, withoutSkill, { collectionIds: [] })).draft;
    expect((await save(owner, removed)).outcome).toBe("saved");
    expect((await loadAgent(owner, agentId))!.row.configRevision).toBe(2);
  });

  it("creates atomically, normalizes only the agent, and returns an idempotent receipt", async () => {
    const owner = await createUser();
    const draft = (
      await patch(owner, await initialize(owner), {
        name: "  Writer  ",
        description: "  Clear writing  ",
        starters: ["  Start  "],
        instructions: "  Keep instructions  ",
      })
    ).draft;
    const [saved, duplicate] = await Promise.all([save(owner, draft), save(owner, draft)]);
    expect(saved.outcome).toBe("saved");
    expect(duplicate).toEqual(saved);
    if (saved.outcome !== "saved") throw new Error("expected saved");
    expect(saved.draft).toMatchObject({
      settings: draft.settings,
      revision: draft.revision,
      targetAgentId: saved.agentId,
      targetRevision: 1,
      savedDraftRevision: draft.revision,
    });
    expect((await loadAgent(owner, saved.agentId))!.row).toMatchObject({
      name: "Writer",
      description: "Clear writing",
      starters: ["Start"],
      instructions: "  Keep instructions  ",
      configRevision: 1,
    });
    expect(await countAgents(owner)).toBe(1);
    expect(events.filter(({ event }) => event.type === "resources.changed")).toHaveLength(1);
    expect(events.filter(({ event }) => event.type === "agent.draft.changed")).toHaveLength(2);
  });

  it("keeps saving later revisions to the same created agent and rejects superseded receipts", async () => {
    const owner = await createUser();
    const first = (await patch(owner, await initialize(owner), { name: "First" })).draft;
    const saved = await save(owner, first);
    if (saved.outcome !== "saved") throw new Error("expected saved");
    const edited = (await patch(owner, saved.draft, { name: "Second" })).draft;
    expect(edited.targetRevision).toBe(1);
    expect(await save(owner, first)).toEqual({ outcome: "conflict", draft: edited });
    const second = await save(owner, edited);
    expect(second).toMatchObject({
      outcome: "saved",
      agentId: saved.agentId,
      configRevision: 2,
      draft: { savedDraftRevision: edited.revision, targetRevision: 2 },
    });
    expect(await save(owner, edited)).toEqual(second);
    expect(await countAgents(owner)).toBe(1);
  });

  it("uses independent draft and target revisions, retaining stale edits until explicit reload", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const initial = await initialize(owner, agentId);
    const draft = (await patch(owner, initial, { instructions: "Working instructions" })).draft;
    await run(
      Effect.flatMap(AgentService, (service) =>
        service.update(owner, {
          ...EMPTY_AGENT_DRAFT,
          agentId,
          expectedRevision: 1,
          name: "External edit",
        }),
      ),
    );
    expect(await save(owner, draft)).toEqual({ outcome: "agent_changed", draft });
    expect((await get(owner, draft))!.targetRevision).toBe(1);
    expect(await reload(owner, initial)).toEqual({ outcome: "conflict", draft });
    const current = await reload(owner, draft);
    expect(current).toMatchObject({
      outcome: "reloaded",
      draft: {
        revision: draft.revision + 1,
        targetRevision: 2,
        settings: { name: "External edit", instructions: "" },
      },
    });
    const edited = (
      await patch(owner, current.draft, { instructions: "Reviewed current configuration" })
    ).draft;
    expect(await save(owner, edited)).toMatchObject({
      outcome: "saved",
      agentId,
      configRevision: 3,
    });
    expect((await reload(owner, await initialize(owner))).outcome).toBe("no_target");
  });

  it("serializes two authoring conversations against the same saved target", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const first = (await patch(owner, await initialize(owner, agentId), { name: "First editor" }))
      .draft;
    const second = (await patch(owner, await initialize(owner, agentId), { name: "Second editor" }))
      .draft;
    const results = await Promise.all([save(owner, first), save(owner, second)]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["agent_changed", "saved"]);
    expect((await loadAgent(owner, agentId))!.row.configRevision).toBe(2);
  });

  it("retains save receipts after target deletion but never recreates that identity", async () => {
    const owner = await createUser();
    const draft = (await patch(owner, await initialize(owner), { name: "Temporary" })).draft;
    const saved = await save(owner, draft);
    if (saved.outcome !== "saved") throw new Error("expected saved");
    await run(Effect.flatMap(AgentService, (service) => service.remove(owner, saved.agentId)));
    expect(await save(owner, saved.draft)).toEqual(saved);
    const edited = (await patch(owner, saved.draft, { name: "Still working" })).draft;
    expect(await save(owner, edited)).toEqual({ outcome: "agent_unavailable", draft: edited });
    expect(await reload(owner, edited)).toEqual({ outcome: "agent_unavailable", draft: edited });
    expect((await get(owner, draft))!.targetAgentId).toBe(saved.agentId);
    expect(await countAgents(owner)).toBe(0);
  });

  it("never implicitly creates a replacement for a deleted edit target that was not saved", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const draft = await initialize(owner, agentId);
    await run(Effect.flatMap(AgentService, (service) => service.remove(owner, agentId)));
    expect(await save(owner, draft)).toEqual({ outcome: "agent_unavailable", draft });
    expect(await countAgents(owner)).toBe(0);
  });

  it("saves a draft whose starter row was never filled in, keeping the draft as reviewed", async () => {
    const owner = await createUser();
    const draft = (
      await patch(owner, await initialize(owner), {
        name: "Helper",
        starters: ["Write a ticket", "  "],
      })
    ).draft;
    const saved = await save(owner, draft);
    if (saved.outcome !== "saved") throw new Error(`expected saved, got ${saved.outcome}`);
    expect((await loadAgent(owner, saved.agentId))!.row.starters).toEqual(["Write a ticket"]);
    // The blank row is normalization for the agent, not an edit to the draft.
    expect((await get(owner, draft))!.settings.starters).toEqual(["Write a ticket", "  "]);
  });

  it("applies the same final model and per-user limits as manual saves", async () => {
    const owner = await createUser();
    const draft = (
      await patch(owner, await initialize(owner), { name: "Model", modelId: "missing-model" })
    ).draft;
    expect(await save(owner, draft)).toMatchObject({
      outcome: "invalid",
      reason: "selected model is unavailable",
      draft,
    });
    const fixed = (await patch(owner, draft, { modelId: null })).draft;
    await run(
      Effect.flatMap(Db, (db) =>
        db.insert(agents).values(
          Array.from({ length: 100 }, (_, i) => ({
            id: uuidv7(),
            userId: owner,
            name: `Existing ${i}`,
          })),
        ),
      ),
    );
    expect(await save(owner, fixed)).toMatchObject({
      outcome: "invalid",
      reason: "agent limit reached",
      draft: fixed,
    });
    expect(await countAgents(owner)).toBe(100);
    expect((await get(owner, fixed))!.targetAgentId).toBeNull();
  });

  it("does not turn postcommit invalidation failure into a failed save or discard a patch", async () => {
    const owner = await createUser();
    const draft = await initialize(owner);
    publishingFails = true;
    const edited = (await patch(owner, draft, { name: "Committed" })).draft;
    const saved = await save(owner, edited);
    expect(saved.outcome).toBe("saved");
    expect((await get(owner, draft))!.savedDraftRevision).toBe(edited.revision);
    expect(await save(owner, edited)).toEqual(saved);
    expect(await countAgents(owner)).toBe(1);
  });

  it("removes the private draft with its conversation", async () => {
    const owner = await createUser();
    const draft = await initialize(owner);
    await run(
      Effect.flatMap(Db, (db) =>
        db.delete(conversations).where(eq(conversations.id, draft.conversationId)),
      ),
    );
    expect(await get(owner, draft)).toBeNull();
    expect(
      await run(
        Effect.flatMap(Db, (db) =>
          db
            .select()
            .from(conversationAgentDrafts)
            .where(eq(conversationAgentDrafts.conversationId, draft.conversationId)),
        ),
      ),
    ).toEqual([]);
  });
});

describe("draft transaction write fences", () => {
  it("rejects aborted, replaced, and changed-owner generation writes without downgrading interruption", async () => {
    const owner = await createUser();
    const draft = await initialize(owner);
    const fence = await generation(owner, draft);
    const write = Effect.flatMap(AgentDraftService, (service) =>
      service.patch(
        owner,
        {
          draftId: draft.id,
          expectedRevision: draft.revision,
          changes: { name: "Late" },
        },
        (tx) => lockGeneration(tx, fence),
      ),
    );
    await run(
      Effect.flatMap(Db, (db) =>
        db.update(messages).set({ status: "aborted" }).where(eq(messages.id, fence.messageId)),
      ),
    );
    interrupted(await runtime.runPromiseExit(write));
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .update(messages)
          .set({ status: "streaming", generationId: uuidv7() })
          .where(eq(messages.id, fence.messageId)),
      ),
    );
    interrupted(await runtime.runPromiseExit(write));
    const nextOwner = await createUser();
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db
          .update(messages)
          .set({ generationId: fence.generationId })
          .where(eq(messages.id, fence.messageId));
        yield* db
          .update(conversations)
          .set({ userId: nextOwner })
          .where(eq(conversations.id, draft.conversationId));
      }),
    );
    interrupted(await runtime.runPromiseExit(write));
    expect((await get(nextOwner, draft))!.revision).toBe(1);
  });

  it("runs a late model guard before the draft lock and observes a Stop committed while waiting", async () => {
    const owner = await createUser();
    const draft = await initialize(owner);
    const fence = await generation(owner, draft);
    const { client, pid } = await controller();
    try {
      await client.query("begin");
      await client.query("select id from conversations where id = $1 for update", [
        draft.conversationId,
      ]);
      const writing = runtime.runPromiseExit(
        Effect.flatMap(AgentDraftService, (service) =>
          service.patch(
            owner,
            {
              draftId: draft.id,
              expectedRevision: draft.revision,
              changes: { name: "Too late" },
            },
            (tx) => lockGeneration(tx, fence),
          ),
        ),
      );
      await waitForBlocked(client, pid);
      // If the waiting model had locked the draft first this statement would deadlock.
      await client.query(
        "select conversation_id from conversation_agent_drafts where conversation_id = $1 for update",
        [draft.conversationId],
      );
      await client.query("update messages set status = 'aborted' where id = $1", [fence.messageId]);
      await client.query("commit");
      interrupted(await writing);
      expect((await get(owner, draft))!.revision).toBe(1);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });

  it("lets an already-fenced model commit before a concurrent manual CAS, without deadlocking", async () => {
    const owner = await createUser();
    const draft = await initialize(owner);
    const fence = await generation(owner, draft);
    const reached = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const { client } = await controller();
    try {
      const model = run(
        Effect.flatMap(AgentDraftService, (service) =>
          service.patch(
            owner,
            {
              draftId: draft.id,
              expectedRevision: draft.revision,
              changes: { name: "Model" },
            },
            (tx) =>
              lockGeneration(tx, fence).pipe(
                Effect.andThen(Deferred.succeed(reached, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
          ),
        ),
      );
      await run(Deferred.await(reached));
      const manual = patch(owner, draft, { name: "Manual" });
      await waitForBlocked(client);
      await run(Deferred.succeed(release, undefined));
      expect((await model).outcome).toBe("updated");
      expect(await manual).toMatchObject({
        outcome: "conflict",
        draft: { settings: { name: "Model" }, revision: 2 },
      });
    } finally {
      await run(Deferred.succeed(release, undefined));
      await client.end();
    }
  });

  it("preserves real cancelled and expired research fence failures rather than reporting draft conflicts", async () => {
    const owner = await createUser();
    const draft = await initialize(owner);
    const fence = {
      conversationId: draft.conversationId,
      messageId: uuidv7(),
      runId: uuidv7(),
      generationId: uuidv7(),
      owner: uuidv7(),
    };
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(messages).values({
          id: fence.messageId,
          conversationId: draft.conversationId,
          role: "assistant",
          status: "streaming",
          generationId: fence.generationId,
        });
        yield* db.insert(researchRuns).values({
          id: fence.runId,
          conversationId: draft.conversationId,
          messageId: fence.messageId,
          generationId: fence.generationId,
          toolCallId: null,
          userId: owner,
          owner: fence.owner,
          status: "running",
          progress: initialResearchProgress(fence.runId),
          modelId: "test-model",
          modelName: "Test model",
          leaseUntil: sql`clock_timestamp() - interval '1 minute'`,
        });
      }),
    );
    const write = Effect.flatMap(AgentDraftService, (service) =>
      service.patch(
        owner,
        {
          draftId: draft.id,
          expectedRevision: 999,
          changes: { name: "Late research" },
        },
        (tx) => lockResearchFence(tx, fence),
      ),
    );
    const expired = await runtime.runPromiseExit(write);
    expect(Exit.isFailure(expired)).toBe(true);
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .update(researchRuns)
          .set({ cancelRequested: true, leaseUntil: sql`clock_timestamp() + interval '5 minutes'` })
          .where(eq(researchRuns.id, fence.runId)),
      ),
    );
    const cancelled = await runtime.runPromiseExit(write);
    expect(Exit.isFailure(cancelled)).toBe(true);
    expect((await get(owner, draft))!.revision).toBe(1);
  });
});
