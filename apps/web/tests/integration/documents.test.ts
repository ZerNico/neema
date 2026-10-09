import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Stream,
} from "effect";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { conversations, documents, documentSteps, messages, user } from "~/db/schema/index.ts";
import { lockGeneration } from "~/modules/chat/server/generation-fence.ts";
import {
  DOCUMENT_LIMITS,
  type EditableDocument,
  type DocumentFrame,
} from "~/modules/documents/schema.ts";
import { normalizeMarkdown } from "~/modules/documents/editor/markdown.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import type { SyncEvent } from "~/modules/sync/events.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { collabEditor } from "../fixtures/collab-editor.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
type Services = Db | DocumentRepo | DocumentService;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
let appLayer: Layer.Layer<Services, unknown>;
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
  database = await createTestDatabase();
  const url = database.url;
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
  );
  const core = Layer.mergeAll(DocumentRepo.layer, TestBus).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(infrastructure),
  );
  appLayer = DocumentService.layer.pipe(Layer.provideMerge(core));
  runtime = ManagedRuntime.make(appLayer);
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});
beforeEach(() => {
  events.length = 0;
  publishingFails = false;
});

// Scoped to one person: an earlier test's throttled publish can land a second
// later, during whichever test runs next.
const changedEvents = (userId?: string) =>
  events.filter(
    (entry) => entry.event.type === "document.changed" && (!userId || entry.userId === userId),
  );
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
/** Already in the form the editor writes Markdown back in, so stored content equals it. */
const CHECKLIST = [
  "# Release",
  "",
  "- [ ] write notes",
  "- [ ] tag build",
  "  - [ ] nested step",
  "",
  "Some prose in the middle",
  "",
  "- [ ] ship",
  "- [ ] announce",
].join("\n");
const service = <A, E>(f: (service: DocumentService["Service"]) => Effect.Effect<A, E>) =>
  run(Effect.flatMap(DocumentService, f));
const create = (userId: string, conversationId: string, content = CHECKLIST, title = "Release") =>
  service((s) => s.create(userId, { conversationId, title, content })).then((r) => r.document);
const get = (userId: string, document: Pick<EditableDocument, "id">) =>
  service((s) => s.get(userId, document.id));
const edit = (
  userId: string,
  document: EditableDocument,
  patch: { old: string; new: string; expectedRevision?: number },
) => service((s) => s.edit(userId, { documentId: document.id, ...patch }));
/** A person's editor on the document, opened from its live feed like the panel's. */
const openEditor = async (userId: string, document: Pick<EditableDocument, "id">) => {
  const editor = await collabEditor(run, userId, document.id);
  if (!editor) throw new Error("expected a feed");
  return editor;
};
/** Ticks one task, which in the tree is the task item's checked attribute. */
const tick = (markdown: string, line: string) => markdown.replace(line, line.replace("[ ]", "[x]"));
const storedSteps = (documentId: string) =>
  run(
    Effect.flatMap(Db, (db) =>
      db.select().from(documentSteps).where(eq(documentSteps.documentId, documentId)),
    ),
  );

const interrupted = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
};
const controller = async () => {
  const client = new Client({ connectionString: database.url });
  await client.connect();
  const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  return { client, pid: rows[0]!.pid };
};

describe("model patches", () => {
  it("keeps its fixture in the canonical form stored content takes", () => {
    expect(normalizeMarkdown(CHECKLIST)).toBe(CHECKLIST);
  });

  it("creates, then edits by a unique anchor, reporting no_match, ambiguous and unchanged", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    expect(created).toMatchObject({
      conversationId,
      title: "Release",
      content: CHECKLIST,
      revision: 0,
      lastEditedBy: "model",
    });
    expect(await get(owner, created)).toEqual(created);

    const updated = await edit(owner, created, {
      old: "- [ ] tag build",
      new: "- [ ] tag build v2",
      expectedRevision: 0,
    });
    expect(updated).toMatchObject({ outcome: "updated", staleRead: false });
    expect(updated.document.revision).toBe(1);
    expect(updated.document.content).toContain("- [ ] tag build v2\n");
    expect(updated.document.content).not.toContain("- [ ] tag build\n");

    const missing = await edit(owner, updated.document, { old: "- [ ] deploy", new: "x" });
    expect(missing.outcome).toBe("no_match");
    if (missing.outcome !== "no_match") throw new Error("expected no_match");
    expect(missing.preview).toBe(updated.document.content);
    expect(missing.document.revision).toBe(1);

    const ambiguous = await edit(owner, updated.document, { old: "- [ ] ", new: "- [x] " });
    expect(ambiguous).toMatchObject({ outcome: "ambiguous", count: 5 });

    // Same text again is not a write: no revision bump, no event.
    const before = changedEvents().length;
    expect(
      await edit(owner, updated.document, { old: "tag build v2", new: "tag build v2" }),
    ).toMatchObject({ outcome: "unchanged", document: { revision: 1 } });
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
    const editor = await openEditor(owner, created);
    expect(await editor.type((markdown) => tick(markdown, "- [ ] write notes"))).toEqual({
      revision: 1,
    });
    const result = await edit(owner, created, {
      old: "- [ ] ship",
      new: "- [ ] ship it",
      expectedRevision: created.revision,
    });
    expect(result).toMatchObject({ outcome: "updated", staleRead: true });
    expect(result.document.content).toContain("- [x] write notes");
    expect(result.document.content).toContain("- [ ] ship it");
    expect(result.document.revision).toBe(2);
  });

  it("replaces the whole content only at the expected revision", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner));
    const replaced = await service((s) =>
      s.replace(owner, { documentId: created.id, content: "# New", expectedRevision: 0 }),
    );
    expect(replaced).toMatchObject({
      outcome: "updated",
      document: { content: "# New", revision: 1, lastEditedBy: "model" },
    });
    expect(
      await service((s) =>
        s.replace(owner, { documentId: created.id, content: "# Stale", expectedRevision: 0 }),
      ),
    ).toEqual({ outcome: "conflict", document: replaced.document });
    expect(
      await service((s) =>
        s.replace(owner, { documentId: created.id, content: "# New", expectedRevision: 1 }),
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
    expect(await service((s) => s.list(owner, { conversationId: conversationId }))).toEqual([
      created,
    ]);
    expect(changedEvents()).toHaveLength(1);
  });
});

describe("person and model writing together", () => {
  it("refuses a person's batch built before a model edit, then takes it rebased", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    const editor = await openEditor(owner, created);
    const fence = await generation(owner, conversationId);
    const reached = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
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
      // Typed against the text before the model's edit, and sent while it is held.
      editor.change((markdown) => tick(markdown, "- [ ] announce"));
      const first = editor.push();
      await run(Deferred.succeed(release, undefined));
      expect((await model).outcome).toBe("updated");
      // Built on the revision the model's edit moved past: refused, nothing stored.
      expect(await first).toEqual({ revision: 1, conflict: true });
      expect(editor.unsent()).toBe(1);
      await editor.catchUp();
      expect(await editor.push()).toEqual({ revision: 2, conflict: false });
      const stored = await get(owner, created);
      expect(stored).toMatchObject({ revision: 2, lastEditedBy: "user", lastEditorUserId: owner });
      expect(editor.markdown()).toBe(stored!.content);
      expect(stored!.content.split("\n")).toEqual([
        "# Release",
        "",
        "- [ ] write the notes",
        "- [ ] tag build",
        "  - [ ] nested step",
        "",
        "Some prose in the middle",
        "",
        "- [ ] ship",
        "- [x] announce",
      ]);
    } finally {
      await run(Deferred.succeed(release, undefined));
    }
  });

  it("stores a person's batch while another transaction holds the conversation lock", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    const editor = await openEditor(owner, created);
    const { client } = await controller();
    try {
      await client.query("begin");
      await client.query("select id from conversations where id = $1 for update", [conversationId]);
      expect(await editor.type((markdown) => tick(markdown, "- [ ] ship"))).toEqual({
        revision: 1,
      });
      expect((await get(owner, created))!.content).toContain("- [x] ship");
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });

  it("orders two editors' concurrent batches and sends every step to every editor", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner));
    const first = await openEditor(owner, created);
    const second = await openEditor(owner, created);
    const feed = await service((s) =>
      s.subscribe(owner, created.id, { revision: 0, clientId: second.clientId }),
    );
    const received = Effect.runFork(feed!.pipe(Stream.take(3), Stream.runCollect));
    // Both editors type at once, each against the same starting text.
    await Promise.all([
      first.type((markdown) => tick(markdown, "- [ ] write notes")),
      second.type((markdown) => tick(markdown, "- [ ] ship")),
    ]);
    const frames = [...(await Effect.runPromise(Fiber.join(received)))] as DocumentFrame[];
    expect(frames[0]).toMatchObject({ type: "steps", steps: [], revision: 0 });
    // Each step comes back to everyone, its sender included: that is how collab confirms it.
    const senders = frames
      .slice(1)
      .flatMap((frame) => (frame.type === "steps" ? frame.clientIds : []));
    expect(new Set(senders)).toEqual(new Set([first.clientId, second.clientId]));
    const stored = await get(owner, created);
    await first.catchUp();
    expect(first.markdown()).toBe(stored!.content);
    expect(second.markdown()).toBe(stored!.content);
    expect(stored!.content).toContain("- [x] write notes");
    expect(stored!.content).toContain("- [x] ship");
    expect(stored!.revision).toBe(2);
  });

  it("relays a cursor to the same person's other editor, and takes it away when it closes", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner));
    const first = await openEditor(owner, created);
    const second = await openEditor(owner, created);
    const secondFeed = await service((s) =>
      s.subscribe(owner, created.id, { revision: 0, clientId: second.clientId }),
    );
    const toSecond = Effect.runFork(secondFeed!.pipe(Stream.take(2), Stream.runCollect));
    const presence = {
      anchor: 3,
      head: 3,
      revision: 0,
      user: { name: "Ada", color: "#2563eb", colorLight: "#2563eb33" },
    };
    await service((s) =>
      s.push(owner, { documentId: created.id, clientId: first.clientId, revision: 0, presence }),
    );
    const frames = [...(await Effect.runPromise(Fiber.join(toSecond)))] as DocumentFrame[];
    expect(frames[1]).toEqual({ type: "presence", clientId: first.clientId, presence });
    // A feed opening later is told about the cursor already there.
    const later = await service((s) =>
      s.subscribe(owner, created.id, { revision: 0, clientId: null }),
    );
    const opening = [
      ...(await Effect.runPromise(later!.pipe(Stream.take(2), Stream.runCollect))),
    ] as DocumentFrame[];
    expect(opening[1]).toEqual({ type: "presence", clientId: first.clientId, presence });
  });

  it("refuses a resent batch instead of storing it twice", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner));
    const editor = await openEditor(owner, created);
    const step = await editor.type((markdown) => tick(markdown, "- [ ] ship"));
    expect(step).toEqual({ revision: 1 });
    const resend = await service((s) =>
      s.push(owner, {
        documentId: created.id,
        clientId: editor.clientId,
        revision: 0,
        steps: [JSON.stringify({ stepType: "replace", from: 1, to: 1 })],
      }),
    );
    expect(resend).toEqual({ revision: 1, conflict: true });
    expect(await storedSteps(created.id)).toHaveLength(1);
  });

  it("refuses a step the schema cannot take, storing nothing", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner));
    await expect(
      service((s) =>
        s.push(owner, {
          documentId: created.id,
          clientId: "editor",
          revision: 0,
          steps: [
            JSON.stringify({
              stepType: "replace",
              from: 0,
              to: 0,
              slice: { content: [{ type: "text", text: "loose text at the top level" }] },
            }),
          ],
        }),
      ),
    ).rejects.toMatchObject({ _tag: "DocumentRejected", reason: "invalid document step" });
    expect(await storedSteps(created.id)).toHaveLength(0);
    expect(await get(owner, created)).toEqual(created);
  });

  it("rebuilds the same text in a new process, and folds only old steps past the threshold", async () => {
    const owner = await createUser();
    const created = await create(owner, await createConversation(owner), "");
    const editor = await openEditor(owner, created);
    for (let index = 0; index < 5; index++)
      // oxlint-disable-next-line eslint/no-await-in-loop -- One batch per round trip, like typing.
      await editor.type((markdown) => (markdown ? `${markdown}\n\n${index}` : `${index}`));
    // A fresh runtime has no entry in memory and must rebuild from storage alone.
    const rebuilt = async () => {
      const fresh = ManagedRuntime.make(appLayer);
      try {
        const feed = await fresh.runPromise(
          Effect.flatMap(DocumentService, (s) =>
            s.subscribe(owner, created.id, { revision: null, clientId: null }),
          ),
        );
        return Option.getOrThrow(await fresh.runPromise(Stream.runHead(feed!)));
      } finally {
        await fresh.dispose();
      }
    };
    const stored = await get(owner, created);
    const frame = await rebuilt();
    if (frame.type !== "reset") throw new Error("expected reset");
    expect(frame.revision).toBe(stored!.revision);
    const base = stored!.revision;

    // Past the threshold, only steps older than the retention period are folded.
    const typing = Array.from({ length: 2_000 }, (_, at) =>
      JSON.stringify({
        stepType: "replace",
        from: 1 + at,
        to: 1 + at,
        slice: { content: [{ type: "text", text: "x" }] },
      }),
    );
    await service((s) =>
      s.push(owner, { documentId: created.id, clientId: "typist", revision: base, steps: typing }),
    );
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .update(documentSteps)
          .set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
          .where(eq(documentSteps.documentId, created.id)),
      ),
    );
    // The in-memory steps carry their own times: a new process reads the backdated ones.
    const fresh = ManagedRuntime.make(appLayer);
    try {
      const result = await fresh.runPromise(
        Effect.flatMap(DocumentService, (s) =>
          s.push(owner, {
            documentId: created.id,
            clientId: "typist",
            revision: base + 2_000,
            steps: [
              JSON.stringify({
                stepType: "replace",
                from: 1,
                to: 1,
                slice: { content: [{ type: "text", text: "y" }] },
              }),
            ],
          }),
        ),
      );
      expect(result).toEqual({ revision: base + 2_001, conflict: false });
    } finally {
      await fresh.dispose();
    }
    const [row] = await run(
      Effect.flatMap(Db, (db) =>
        db
          .select({ snapshotRevision: documents.snapshotRevision })
          .from(documents)
          .where(eq(documents.id, created.id)),
      ),
    );
    expect(row!.snapshotRevision).toBe(base + 1);
    expect(await storedSteps(created.id)).toHaveLength(2_000);
    const after = await rebuilt();
    if (after.type !== "reset") throw new Error("expected reset");
    expect(after.revision).toBe(base + 2_001);
    expect((await get(owner, created))!.content).toMatch(/^yx{2000}0\n\n1/);
  });
});

describe("ownership, limits and sync", () => {
  it("hides another user's documents and refuses their writes", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    expect(await get(stranger, created)).toBeNull();
    expect(await service((s) => s.list(stranger, { conversationId: conversationId }))).toEqual([]);
    await Promise.all(
      [
        service((s) => s.create(stranger, { conversationId, title: "Intruder", content: "" })),
        edit(stranger, created, { old: "ship", new: "sink" }),
        service((s) =>
          s.replace(stranger, { documentId: created.id, content: "", expectedRevision: 0 }),
        ),
        service((s) =>
          s.push(stranger, {
            documentId: created.id,
            clientId: "stranger",
            revision: 0,
            steps: [JSON.stringify({ stepType: "replace", from: 1, to: 1 })],
          }),
        ),
      ].map((action) => expect(action).rejects.toThrow()),
    );
    expect(
      await service((s) => s.subscribe(stranger, created.id, { revision: null, clientId: null })),
    ).toBeNull();
    expect(await get(owner, created)).toEqual(created);
    expect(await service((s) => s.list(owner, { conversationId: conversationId }))).toEqual([
      created,
    ]);
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
    const editor = await openEditor(owner, created);
    await expect(editor.type((markdown) => huge + markdown)).rejects.toMatchObject(overCap);
    expect(await get(owner, created)).toEqual(created);
    // The refused batch left nothing behind in memory: a fresh editor starts from storage.
    const next = await openEditor(owner, created);
    expect(next.markdown()).toBe("small");
    expect(await service((s) => s.list(owner, { conversationId: conversationId }))).toEqual([
      created,
    ]);
    expect(await next.type(() => "smaller")).toEqual({ revision: 1 });
  });

  it("publishes exactly one event per successful write and survives a bus failure", async () => {
    const owner = await createUser();
    const conversationId = await createConversation(owner);
    const created = await create(owner, conversationId);
    expect(changedEvents(owner)).toEqual([
      {
        userId: owner,
        event: { type: "document.changed", conversationId, documentId: created.id },
      },
    ]);
    await edit(owner, created, { old: "nothing", new: "x" });
    expect(changedEvents(owner)).toHaveLength(1);
    publishingFails = true;
    const edited = await edit(owner, created, { old: "- [ ] ship", new: "- [x] ship" });
    expect(edited.outcome).toBe("updated");
    expect(await get(owner, created)).toEqual(edited.document);
    expect(changedEvents(owner)).toHaveLength(1);
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
          db.select().from(documents).where(eq(documents.conversationId, conversationId)),
        ),
      ),
    ).toEqual([]);
  });
});
