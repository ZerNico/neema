import { PgClient } from "@effect/sql-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { conversationDocuments, conversations, messages, user } from "~/db/schema/index.ts";
import { lockGeneration } from "~/modules/chat/server/generation-fence.ts";
import { DOCUMENT_LIMITS, type ConversationDocument } from "~/modules/documents/schema.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import type { SyncEvent } from "~/modules/sync/events.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

let container: StartedPostgreSqlContainer;
type Services = Db | DocumentRepo | DocumentService;
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
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
  );
  const core = Layer.mergeAll(DocumentRepo.layer, TestBus).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(infrastructure),
  );
  runtime = ManagedRuntime.make(DocumentService.layer.pipe(Layer.provideMerge(core)));
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});
beforeEach(() => {
  events.length = 0;
  publishingFails = false;
});

const changedEvents = () => events.filter(({ event }) => event.type === "document.changed");
const createUser = () =>
  run(
    Effect.gen(function* () {
      const id = uuidv7();
      yield* (yield* Db).insert(user).values({ id, name: "Document owner", email: `${id}@t.io` });
      return id;
    }),
  );
const createConversation = async (userId: string) => {
  const id = uuidv7();
  await run(Effect.flatMap(Db, (db) => db.insert(conversations).values({ id, userId })));
  return id;
};
const generation = (userId: string, conversationId: string) =>
  run(
    Effect.gen(function* () {
      const fence = { userId, conversationId, messageId: uuidv7(), generationId: uuidv7() };
      yield* (yield* Db).insert(messages).values({
        id: fence.messageId,
        conversationId,
        generationId: fence.generationId,
        role: "assistant",
        status: "streaming",
      });
      return fence;
    }),
  );
const CHECKLIST = [
  "# Release",
  "- [ ] write notes",
  "- [ ] tag build",
  "  - [ ] nested step",
  "1. [ ] numbered step",
  "Some prose in the middle",
  "- [ ] ship",
  "- [ ] announce",
].join("\n");
const service = <A, E>(f: (service: DocumentService["Service"]) => Effect.Effect<A, E>) =>
  run(Effect.flatMap(DocumentService, f));
const create = (userId: string, conversationId: string, content = CHECKLIST, title = "Release") =>
  service((s) => s.create(userId, { conversationId, title, content })).then((r) => r.document);
const get = (userId: string, document: Pick<ConversationDocument, "id">) =>
  service((s) => s.get(userId, document.id));
const edit = (
  userId: string,
  document: ConversationDocument,
  patch: { old: string; new: string; expectedRevision?: number },
) => service((s) => s.edit(userId, { documentId: document.id, ...patch }));
const toggle = (userId: string, document: ConversationDocument, ordinal: number, checked = true) =>
  service((s) => s.toggleTask(userId, { documentId: document.id, ordinal, checked }));

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

describe("model patches", () => {
  it("creates, then edits by a unique anchor, reporting no_match, ambiguous and unchanged", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    expect(created).toMatchObject({
      conversationId,
      title: "Release",
      content: CHECKLIST,
      revision: 1,
      lastEditedBy: "model",
    });
    expect(await get(owner, created)).toEqual(created);

    const updated = await edit(owner, created, {
      old: "- [ ] tag build",
      new: "- [ ] tag build v2",
      expectedRevision: 1,
    });
    expect(updated).toMatchObject({ outcome: "updated", staleRead: false });
    expect(updated.document.revision).toBe(2);
    expect(updated.document.content).toContain("- [ ] tag build v2\n");
    expect(updated.document.content).not.toContain("- [ ] tag build\n");

    const missing = await edit(owner, updated.document, { old: "- [ ] deploy", new: "x" });
    expect(missing.outcome).toBe("no_match");
    if (missing.outcome !== "no_match") throw new Error("expected no_match");
    expect(missing.preview).toBe(updated.document.content);
    expect(missing.document.revision).toBe(2);

    const ambiguous = await edit(owner, updated.document, { old: "- [ ] ", new: "- [x] " });
    expect(ambiguous).toMatchObject({ outcome: "ambiguous", count: 5 });

    // Same text again is not a write: no revision bump, no event.
    const before = changedEvents().length;
    expect(
      await edit(owner, updated.document, { old: "tag build v2", new: "tag build v2" }),
    ).toMatchObject({ outcome: "unchanged", document: { revision: 2 } });
    expect(changedEvents()).toHaveLength(before);
    // Longer preview stops at the cap so a huge document does not come back whole.
    const long = await create(
      owner,
      conversationId,
      Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
    );
    const capped = await edit(owner, long, { old: "nothing here", new: "" });
    if (capped.outcome !== "no_match") throw new Error("expected no_match");
    expect(capped.preview.split("\n")).toHaveLength(DOCUMENT_LIMITS.noMatchPreviewLines);
  });

  it("flags a stale expectedRevision on edit without refusing it", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner));
    const ticked = await toggle(owner, created, 0);
    expect(ticked).toMatchObject({ outcome: "updated", document: { revision: 2 } });
    const result = await edit(owner, created, {
      old: "- [ ] ship",
      new: "- [ ] ship it",
      expectedRevision: created.revision,
    });
    expect(result).toMatchObject({ outcome: "updated", staleRead: true });
    expect(result.document.content).toContain("- [x] write notes");
    expect(result.document.content).toContain("- [ ] ship it");
    expect(result.document.revision).toBe(3);
  });

  it("replaces the whole content only at the expected revision", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner));
    const replaced = await service((s) =>
      s.replace(owner, { documentId: created.id, content: "# New", expectedRevision: 1 }),
    );
    expect(replaced).toMatchObject({
      outcome: "updated",
      document: { content: "# New", revision: 2, lastEditedBy: "model" },
    });
    expect(
      await service((s) =>
        s.replace(owner, { documentId: created.id, content: "# Stale", expectedRevision: 1 }),
      ),
    ).toEqual({ outcome: "conflict", document: replaced.document });
    expect(
      await service((s) =>
        s.replace(owner, { documentId: created.id, content: "# New", expectedRevision: 2 }),
      ),
    ).toEqual({ outcome: "unchanged", document: replaced.document });
  });

  it("interrupts a fenced write once the generation is superseded", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    const fence = await generation(owner, conversationId);
    const write = Effect.flatMap(DocumentService, (s) =>
      s.edit(owner, { documentId: created.id, old: "- [ ] ship", new: "- [ ] ship late" }, (tx) =>
        lockGeneration(tx, fence),
      ),
    );
    const creating = Effect.flatMap(DocumentService, (s) =>
      s.create(owner, { conversationId, title: "Late", content: "x" }, (tx) =>
        lockGeneration(tx, fence),
      ),
    );
    await run(
      Effect.flatMap(Db, (db) =>
        db.update(messages).set({ generationId: uuidv7() }).where(eq(messages.id, fence.messageId)),
      ),
    );
    interrupted(await runtime.runPromiseExit(write));
    interrupted(await runtime.runPromiseExit(creating));
    expect(await get(owner, created)).toEqual(created);
    expect(await service((s) => s.list(owner, conversationId))).toEqual([created]);
    expect(changedEvents()).toHaveLength(1);
  });
});

describe("person and model writing together", () => {
  it("lands a tick on one line while a model edit to another is held open", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    const fence = await generation(owner, conversationId);
    const reached = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const { client } = await controller();
    try {
      const model = run(
        Effect.flatMap(DocumentService, (s) =>
          s.edit(
            owner,
            { documentId: created.id, old: "- [ ] write notes", new: "- [ ] write the notes" },
            (tx) =>
              lockGeneration(tx, fence).pipe(
                Effect.andThen(Deferred.succeed(reached, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
          ),
        ),
      );
      await run(Deferred.await(reached));
      // Ordinal 5 is "- [ ] announce", the eighth line of the source.
      const tick = toggle(owner, created, 5);
      await waitForBlocked(client);
      await run(Deferred.succeed(release, undefined));
      expect((await model).outcome).toBe("updated");
      const ticked = await tick;
      expect(ticked).toMatchObject({
        outcome: "updated",
        document: { revision: 3, lastEditedBy: "user" },
      });
      expect(ticked.document.content.split("\n")).toEqual([
        "# Release",
        "- [ ] write the notes",
        "- [ ] tag build",
        "  - [ ] nested step",
        "1. [ ] numbered step",
        "Some prose in the middle",
        "- [ ] ship",
        "- [x] announce",
      ]);
      expect(changedEvents()).toHaveLength(3);
    } finally {
      await run(Deferred.succeed(release, undefined));
      await client.end();
    }
  });

  it("toggles by ordinal across nested and numbered items and refuses a missing one", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner));
    const nested = await toggle(owner, created, 2);
    expect(nested.document.content).toContain("  - [x] nested step");
    const numbered = await toggle(owner, nested.document, 3);
    expect(numbered.document.content).toContain("1. [x] numbered step");
    expect(numbered.document.content).toContain("- [ ] ship");
    const untick = await toggle(owner, numbered.document, 2, false);
    expect(untick.document.content).toContain("  - [ ] nested step");
    expect(untick.document.revision).toBe(4);
    expect(await toggle(owner, untick.document, 3, true)).toEqual({
      outcome: "unchanged",
      document: untick.document,
    });
    expect(await toggle(owner, untick.document, 99)).toEqual({
      outcome: "no_match",
      document: untick.document,
    });
    expect(
      await service((s) =>
        s.toggleTask(owner, {
          documentId: created.id,
          ordinal: 0,
          checked: true,
          expectedRevision: 1,
        }),
      ),
    ).toEqual({ outcome: "conflict", document: untick.document });
  });

  it("saves the person's editor under CAS and marks the document theirs", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner));
    const results = await Promise.all([
      service((s) =>
        s.writeUser(owner, { documentId: created.id, content: "A", expectedRevision: 1 }),
      ),
      service((s) =>
        s.writeUser(owner, { documentId: created.id, content: "B", expectedRevision: 1 }),
      ),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["conflict", "updated"]);
    expect(results[0]!.document).toEqual(results[1]!.document);
    expect(results[0]!.document).toMatchObject({ revision: 2, lastEditedBy: "user" });
    expect(changedEvents()).toHaveLength(2);
  });
});

describe("ownership, limits and sync", () => {
  it("hides another user's documents and refuses their writes", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    expect(await get(stranger, created)).toBeNull();
    expect(await service((s) => s.list(stranger, conversationId))).toEqual([]);
    await Promise.all(
      [
        service((s) => s.create(stranger, { conversationId, title: "Intruder", content: "" })),
        edit(stranger, created, { old: "ship", new: "sink" }),
        service((s) =>
          s.replace(stranger, { documentId: created.id, content: "", expectedRevision: 1 }),
        ),
        service((s) =>
          s.writeUser(stranger, { documentId: created.id, content: "", expectedRevision: 1 }),
        ),
        toggle(stranger, created, 0),
      ].map((action) => expect(action).rejects.toThrow()),
    );
    expect(await get(owner, created)).toEqual(created);
    expect(await service((s) => s.list(owner, conversationId))).toEqual([created]);
  });

  it("rejects content over the cap as invalid before and after a patch", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const huge = "x".repeat(DOCUMENT_LIMITS.chars + 1);
    const overCap = { _tag: "DocumentRejected", reason: expect.stringContaining("exceeds") };
    await expect(
      service((s) => s.create(owner, { conversationId, title: "Huge", content: huge })),
    ).rejects.toMatchObject(overCap);
    const created = await create(owner, conversationId, "small");
    await expect(edit(owner, created, { old: "small", new: huge })).rejects.toMatchObject(overCap);
    await expect(
      service((s) =>
        s.writeUser(owner, { documentId: created.id, content: huge, expectedRevision: 1 }),
      ),
    ).rejects.toMatchObject(overCap);
    expect(await get(owner, created)).toEqual(created);
    expect(await service((s) => s.list(owner, conversationId))).toEqual([created]);
  });

  it("publishes exactly one event per successful write and survives a bus failure", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    expect(changedEvents()).toEqual([
      {
        userId: owner,
        event: { type: "document.changed", conversationId, documentId: created.id },
      },
    ]);
    await edit(owner, created, { old: "nothing", new: "x" });
    expect(changedEvents()).toHaveLength(1);
    publishingFails = true;
    const edited = await edit(owner, created, { old: "- [ ] ship", new: "- [x] ship" });
    expect(edited.outcome).toBe("updated");
    expect(await get(owner, created)).toEqual(edited.document);
    expect(changedEvents()).toHaveLength(1);
  });

  it("removes a document with the answer that created it", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const fence = await generation(owner, conversationId);
    const anchored = await service((s) =>
      s.create(owner, {
        conversationId,
        createdByMessageId: fence.messageId,
        title: "Anchored",
        content: CHECKLIST,
      }),
    ).then((r) => r.document);
    const loose = await create(owner, conversationId, "no anchor", "Loose");
    expect(anchored.createdByMessageId).toBe(fence.messageId);

    // Rewinding past that answer deletes the message; the document goes with it
    // rather than surviving as an artifact of a conversation prefix that is gone.
    await run(
      Effect.flatMap(Db, (db) => db.delete(messages).where(eq(messages.id, fence.messageId))),
    );

    expect(await get(owner, anchored)).toBeNull();
    expect(await get(owner, loose)).toEqual(loose);
  });

  it("removes documents with their conversation", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    await run(
      Effect.flatMap(Db, (db) =>
        db.delete(conversations).where(eq(conversations.id, conversationId)),
      ),
    );
    expect(await get(owner, created)).toBeNull();
    expect(
      await run(
        Effect.flatMap(Db, (db) =>
          db
            .select()
            .from(conversationDocuments)
            .where(eq(conversationDocuments.conversationId, conversationId)),
        ),
      ),
    ).toEqual([]);
  });
});
