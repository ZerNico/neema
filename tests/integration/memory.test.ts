import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import {
  conversations,
  memories,
  memorySettings,
  messages,
  tools,
  user,
} from "~/db/schema/index.ts";
import { hashSourceMessageContent } from "~/modules/memory/server/content-hash.ts";
import { MemoryRepo } from "~/modules/memory/server/repo.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 11).toString("base64");

let container: StartedPostgreSqlContainer;
let runtime: ManagedRuntime.ManagedRuntime<MemoryRepo | MemoryService | ToolsRepo | Db, unknown>;
const published: Array<{ userId: string; type: string }> = [];
let syncShouldFail = false;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const FakeSync = Layer.succeed(SyncBus, {
  publish: (userId, event) =>
    syncShouldFail
      ? Effect.die("sync unavailable")
      : Effect.sync(() => {
          published.push({ userId, type: event.type });
        }),
  publishGlobal: (event) =>
    syncShouldFail
      ? Effect.die("sync unavailable")
      : Effect.sync(() => {
          published.push({ userId: "*", type: event.type });
        }),
  subscribe: () => Stream.empty,
});

const createUser = async () => {
  const id = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db
        .insert(user)
        .values({ id, name: "Memory Test", email: `${id}@example.com` })
        .pipe(Effect.orDie);
    }),
  );
  return id;
};

const createSource = async (userId: string, content = "I prefer concise answers") => {
  const conversationId = uuidv7();
  const messageId = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db
        .insert(conversations)
        .values({ id: conversationId, userId, title: "Memory source" })
        .pipe(Effect.orDie);
      yield* db
        .insert(messages)
        .values({ id: messageId, conversationId, role: "user", content })
        .pipe(Effect.orDie);
    }),
  );
  return {
    sourceConversationId: conversationId,
    sourceMessageId: messageId,
    content,
    sourceMessageHash: hashSourceMessageContent(content),
  };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  const Infra = Layer.mergeAll(Db.layer, KeyCipher.layer).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
  );
  const Repos = Layer.mergeAll(MemoryRepo.layer, ToolsRepo.layer).pipe(Layer.provideMerge(Infra));
  runtime = ManagedRuntime.make(
    MemoryService.layer.pipe(Layer.provideMerge(Layer.mergeAll(Repos, FakeSync))),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});

describe("saved memory repository", () => {
  it("uses safe defaults, isolates users, and deduplicates normalized content", async () => {
    const firstUser = await createUser();
    const secondUser = await createUser();

    await expect(
      runtime.runPromise(MemoryService.use((service) => service.getSettings(firstUser))),
    ).resolves.toMatchObject({
      referenceEnabled: true,
      autoSaveEnabled: true,
      globalEnabled: true,
      effectiveReferenceEnabled: true,
      effectiveAutoSaveEnabled: true,
    });

    const first = await runtime.runPromise(
      MemoryService.use((service) =>
        service.createManual(firstUser, "  Prefers   concise answers. "),
      ),
    );
    const duplicate = await runtime.runPromise(
      MemoryService.use((service) => service.createManual(firstUser, "prefers concise answers!!")),
    );
    const otherUser = await runtime.runPromise(
      MemoryService.use((service) => service.createManual(secondUser, "Prefers concise answers")),
    );

    expect(first.outcome).toBe("created");
    expect(duplicate.outcome).toBe("duplicate");
    expect(otherUser.outcome).toBe("created");
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.list(firstUser))),
    ).resolves.toHaveLength(1);
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.list(secondUser))),
    ).resolves.toHaveLength(1);
  });

  it("promotes a manually re-added automatic memory to a protected manual row", async () => {
    const userId = await createUser();
    const source = await createSource(userId);
    const automatic = await runtime.runPromise(
      MemoryService.use((service) =>
        service.saveModel(userId, { ...source, content: "Prefers concise answers" }),
      ),
    );
    if (automatic.outcome !== "created") throw new Error("expected created automatic memory");

    published.length = 0;
    const promoted = await runtime.runPromise(
      MemoryService.use((service) => service.createManual(userId, "Prefers concise answers.")),
    );

    expect(promoted).toMatchObject({
      outcome: "updated",
      memory: {
        id: automatic.memory.id,
        origin: "manual",
        editedAt: null,
        sourceConversationId: null,
        sourceMessageId: null,
      },
    });
    expect(published).toEqual([{ userId, type: "memory.changed" }]);
    await expect(
      runtime.runPromise(
        MemoryService.use((service) =>
          service.saveModel(userId, {
            ...source,
            memoryId: automatic.memory.id,
            content: "Replace automatically",
          }),
        ),
      ),
    ).resolves.toEqual({ outcome: "protected" });
  });

  it("preserves user preferences and manual CRUD while global memory fails closed", async () => {
    const userId = await createUser();
    const source = await createSource(userId);

    await runtime.runPromise(
      ToolsRepo.use((repo) => repo.updateTool("memory", { enabled: false })),
    );
    const settings = await runtime.runPromise(
      MemoryService.use((service) =>
        service.updateSettings(userId, { referenceEnabled: true, autoSaveEnabled: true }),
      ),
    );
    expect(settings).toMatchObject({
      referenceEnabled: true,
      autoSaveEnabled: true,
      globalEnabled: false,
      effectiveReferenceEnabled: false,
      effectiveAutoSaveEnabled: false,
    });

    await expect(
      runtime.runPromise(MemoryService.use((service) => service.createManual(userId, "Manual"))),
    ).resolves.toMatchObject({ outcome: "created" });
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.list(userId))),
    ).resolves.toHaveLength(1);
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.listReferenceable(userId))),
    ).resolves.toEqual([]);
    await expect(
      runtime.runPromise(
        MemoryService.use((service) =>
          service.saveModel(userId, { ...source, content: "Blocked" }),
        ),
      ),
    ).resolves.toEqual({ outcome: "disabled" });

    await runtime.runPromise(
      Db.use((db) => db.delete(tools).where(eq(tools.name, "memory")).pipe(Effect.orDie)),
    );
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.getSettings(userId))),
    ).resolves.toMatchObject({ globalEnabled: false, effectiveAutoSaveEnabled: false });
    await expect(
      runtime.runPromise(
        MemoryService.use((service) =>
          service.saveModel(userId, { ...source, content: "Still blocked" }),
        ),
      ),
    ).resolves.toEqual({ outcome: "disabled" });

    // Restore the seeded row for the remaining sequential tests.
    await runtime.runPromise(
      Db.use((db) =>
        db
          .insert(tools)
          .values({ id: uuidv7(), name: "memory", kind: "memory", enabled: true, config: {} })
          .pipe(Effect.orDie),
      ),
    );
  });

  it("reports only actual global tool enable changes", async () => {
    await runtime.runPromise(ToolsRepo.use((repo) => repo.updateTool("memory", { enabled: true })));

    await expect(
      runtime.runPromise(ToolsRepo.use((repo) => repo.setToolEnabled("memory", true))),
    ).resolves.toMatchObject({ changed: false, tool: { enabled: true } });
    await expect(
      runtime.runPromise(ToolsRepo.use((repo) => repo.setToolEnabled("memory", false))),
    ).resolves.toMatchObject({ changed: true, tool: { enabled: false } });
    await expect(
      runtime.runPromise(ToolsRepo.use((repo) => repo.setToolEnabled("memory", false))),
    ).resolves.toMatchObject({ changed: false, tool: { enabled: false } });
    await expect(
      runtime.runPromise(ToolsRepo.use((repo) => repo.setToolEnabled("memory", true))),
    ).resolves.toMatchObject({ changed: true, tool: { enabled: true } });
  });

  it("serializes automatic saves with concurrent admin disables", async () => {
    const userId = await createUser();
    const source = await createSource(userId);
    const updateStarted = deferred();
    const allowCommit = deferred();

    const disable = runtime.runPromise(
      Db.use((db) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.update(tools).set({ enabled: false }).where(eq(tools.name, "memory"));
              updateStarted.resolve();
              yield* Effect.promise(() => allowCommit.promise);
            }),
          )
          .pipe(Effect.orDie),
      ),
    );
    await updateStarted.promise;

    let saveSettled = false;
    const save = runtime
      .runPromise(
        MemoryService.use((service) =>
          service.saveModel(userId, { ...source, content: "Blocked during disable" }),
        ),
      )
      .finally(() => {
        saveSettled = true;
      });

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(saveSettled).toBe(false);
    } finally {
      allowCommit.resolve();
    }

    await disable;
    await expect(save).resolves.toEqual({ outcome: "disabled" });
    await runtime.runPromise(ToolsRepo.use((repo) => repo.updateTool("memory", { enabled: true })));
  });

  it("serializes source validation with concurrent message edits", async () => {
    const userId = await createUser();
    const source = await createSource(userId);
    const editStarted = deferred();
    const allowEditCommit = deferred();

    const edit = runtime.runPromise(
      Db.use((db) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(messages)
                .set({ content: "I now prefer detailed answers" })
                .where(eq(messages.id, source.sourceMessageId));
              editStarted.resolve();
              yield* Effect.promise(() => allowEditCommit.promise);
            }),
          )
          .pipe(Effect.orDie),
      ),
    );
    await editStarted.promise;

    let saveSettled = false;
    const save = runtime
      .runPromise(
        MemoryService.use((service) =>
          service.saveModel(userId, { ...source, content: "Prefers concise answers" }),
        ),
      )
      .finally(() => {
        saveSettled = true;
      });

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(saveSettled).toBe(false);
    } finally {
      allowEditCommit.resolve();
    }

    await edit;
    await expect(save).resolves.toEqual({ outcome: "source_changed" });
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.list(userId))),
    ).resolves.toEqual([]);
  });

  it("protects user-managed memories and rejects stale generation provenance", async () => {
    const userId = await createUser();
    const source = await createSource(userId);
    await runtime.runPromise(
      MemoryService.use((service) =>
        service.updateSettings(userId, { referenceEnabled: true, autoSaveEnabled: true }),
      ),
    );

    const saved = await runtime.runPromise(
      MemoryService.use((service) => service.saveModel(userId, { ...source, content: "Concise" })),
    );
    if (saved.outcome !== "created") throw new Error("expected created model memory");

    await runtime.runPromise(
      MemoryService.use((service) =>
        service.updateManual(userId, {
          memoryId: saved.memory.id,
          content: "Detailed when useful",
        }),
      ),
    );
    await expect(
      runtime.runPromise(
        MemoryService.use((service) =>
          service.saveModel(userId, {
            ...source,
            memoryId: saved.memory.id,
            content: "Replace automatically",
          }),
        ),
      ),
    ).resolves.toEqual({ outcome: "protected" });

    await runtime.runPromise(
      Db.use((db) =>
        db
          .update(messages)
          .set({ content: "I now prefer detailed answers" })
          .where(eq(messages.id, source.sourceMessageId))
          .pipe(Effect.orDie),
      ),
    );
    await expect(
      runtime.runPromise(
        MemoryService.use((service) => service.saveModel(userId, { ...source, content: "Stale" })),
      ),
    ).resolves.toEqual({ outcome: "source_changed" });
  });

  it("keeps automatic memories active when their original source changes", async () => {
    const userId = await createUser();
    const originalSource = await createSource(userId, "I prefer concise answers");
    const saved = await runtime.runPromise(
      MemoryService.use((service) =>
        service.saveModel(userId, { ...originalSource, content: "Prefers concise answers" }),
      ),
    );
    if (saved.outcome !== "created") throw new Error("expected created automatic memory");

    await runtime.runPromise(
      Db.use((db) =>
        db
          .update(messages)
          .set({ content: "That old message has changed" })
          .where(eq(messages.id, originalSource.sourceMessageId))
          .pipe(Effect.orDie),
      ),
    );
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.listReferenceable(userId))),
    ).resolves.toMatchObject([{ id: saved.memory.id, content: "Prefers concise answers" }]);

    const newSource = await createSource(userId, "I now prefer detailed answers");
    await expect(
      runtime.runPromise(
        MemoryService.use((service) =>
          service.saveModel(userId, {
            ...newSource,
            memoryId: saved.memory.id,
            content: "Prefers detailed answers",
          }),
        ),
      ),
    ).resolves.toMatchObject({ outcome: "updated", memory: { id: saved.memory.id } });
  });

  it("merges duplicate edits and automatic replacements without leaving obsolete rows", async () => {
    const userId = await createUser();
    const first = await runtime.runPromise(
      MemoryService.use((service) => service.createManual(userId, "First preference")),
    );
    const second = await runtime.runPromise(
      MemoryService.use((service) => service.createManual(userId, "Second preference")),
    );
    if (first.outcome !== "created" || second.outcome !== "created") {
      throw new Error("expected two created memories");
    }

    await expect(
      runtime.runPromise(
        MemoryService.use((service) =>
          service.updateManual(userId, {
            memoryId: first.memory.id,
            content: "second preference.",
          }),
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "updated",
      memory: {
        id: second.memory.id,
        content: "second preference.",
        editedAt: expect.any(String),
      },
    });
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.list(userId))),
    ).resolves.toMatchObject([{ id: second.memory.id, content: "second preference." }]);

    const sourceA = await createSource(userId, "I like tea");
    const sourceB = await createSource(userId, "I like coffee");
    const automaticA = await runtime.runPromise(
      MemoryService.use((service) =>
        service.saveModel(userId, { ...sourceA, content: "Likes tea" }),
      ),
    );
    const automaticB = await runtime.runPromise(
      MemoryService.use((service) =>
        service.saveModel(userId, { ...sourceB, content: "Likes coffee" }),
      ),
    );
    if (automaticA.outcome !== "created" || automaticB.outcome !== "created") {
      throw new Error("expected two automatic memories");
    }

    await expect(
      runtime.runPromise(
        MemoryService.use((service) =>
          service.saveModel(userId, {
            ...sourceA,
            memoryId: automaticA.memory.id,
            content: "Likes coffee",
          }),
        ),
      ),
    ).resolves.toMatchObject({ outcome: "updated", memory: { id: automaticB.memory.id } });
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.list(userId))),
    ).resolves.toHaveLength(2);
  });

  it("refreshes provenance when an automatic duplicate is saved from a new source", async () => {
    const userId = await createUser();
    const oldSource = await createSource(userId, "I prefer dark mode");
    const original = await runtime.runPromise(
      MemoryService.use((service) =>
        service.saveModel(userId, { ...oldSource, content: "Prefers dark mode" }),
      ),
    );
    expect(original.outcome).toBe("created");

    await runtime.runPromise(
      Db.use((db) =>
        db
          .delete(conversations)
          .where(eq(conversations.id, oldSource.sourceConversationId))
          .pipe(Effect.orDie),
      ),
    );
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.listReferenceable(userId))),
    ).resolves.toMatchObject([{ content: "Prefers dark mode" }]);

    const newSource = await createSource(userId, "I still prefer dark mode");
    await expect(
      runtime.runPromise(
        MemoryService.use((service) =>
          service.saveModel(userId, { ...newSource, content: "Prefers dark mode" }),
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "updated",
      memory: { sourceConversationId: newSource.sourceConversationId },
    });
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.listReferenceable(userId))),
    ).resolves.toHaveLength(1);
  });

  it("reads initialized preferences without attempting another insert", async () => {
    const userId = await createUser();
    const repo = await runtime.runPromise(MemoryRepo);
    const db = await runtime.runPromise(Db);
    const initial = await runtime.runPromise(repo.getSettings(userId));
    const insert = vi.spyOn(db, "insert");
    try {
      await expect(runtime.runPromise(repo.getSettings(userId))).resolves.toEqual(initial);
      expect(insert).not.toHaveBeenCalled();
    } finally {
      insert.mockRestore();
    }
  });

  it("initializes one settings row for concurrent first reads", async () => {
    const userId = await createUser();
    const repo = await runtime.runPromise(MemoryRepo);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runtime.runPromise(repo.getSettings(userId))),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    const rows = await runtime.runPromise(
      Db.pipe(
        Effect.flatMap((db) =>
          db.select().from(memorySettings).where(eq(memorySettings.userId, userId)),
        ),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(results[0]).toMatchObject({ referenceEnabled: true, autoSaveEnabled: true });
  });

  it("rereads the winning preferences when initialization commits after the first select", async () => {
    const userId = await createUser();
    const repo = await runtime.runPromise(MemoryRepo);
    const db = await runtime.runPromise(Db);
    const inserted = deferred();
    const release = deferred();
    const writer = runtime.runPromise(
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .insert(memorySettings)
            .values({ userId, referenceEnabled: false, autoSaveEnabled: false });
          inserted.resolve();
          yield* Effect.promise(() => release.promise);
        }),
      ),
    );
    await inserted.promise;
    const insert = vi.spyOn(db, "insert");
    const reader = runtime.runPromise(repo.getSettings(userId));
    try {
      // The uncommitted row is invisible to SELECT; its unique key blocks INSERT
      // until the writer commits. The fallback read must use that writer's flags.
      await vi.waitFor(() => expect(insert).toHaveBeenCalledWith(memorySettings));
      release.resolve();
      await writer;
      await expect(reader).resolves.toMatchObject({
        referenceEnabled: false,
        autoSaveEnabled: false,
      });
    } finally {
      release.resolve();
      await Promise.allSettled([writer, reader]);
      insert.mockRestore();
    }
  });

  it("applies concurrent preference patches without overwriting another switch", async () => {
    const userId = await createUser();
    await Promise.all([
      runtime.runPromise(
        MemoryService.use((service) => service.updateSettings(userId, { referenceEnabled: false })),
      ),
      runtime.runPromise(
        MemoryService.use((service) => service.updateSettings(userId, { autoSaveEnabled: false })),
      ),
    ]);

    await expect(
      runtime.runPromise(MemoryService.use((service) => service.getSettings(userId))),
    ).resolves.toMatchObject({ referenceEnabled: false, autoSaveEnabled: false });
  });

  it("serializes concurrent writes so the per-user cap is never exceeded", async () => {
    const userId = await createUser();
    const outcomes = await Promise.all(
      Array.from({ length: 55 }, (_, index) =>
        runtime.runPromise(
          MemoryService.use((service) => service.createManual(userId, `Memory number ${index}`)),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.outcome === "created")).toHaveLength(50);
    expect(outcomes.filter((outcome) => outcome.outcome === "limit_reached")).toHaveLength(5);
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.list(userId))),
    ).resolves.toHaveLength(50);
  });

  it("keeps memories when a source chat is deleted and cascades them with the account", async () => {
    const userId = await createUser();
    const source = await createSource(userId);
    await runtime.runPromise(
      MemoryService.use((service) =>
        service.updateSettings(userId, { referenceEnabled: true, autoSaveEnabled: true }),
      ),
    );
    const saved = await runtime.runPromise(
      MemoryService.use((service) => service.saveModel(userId, { ...source, content: "Keep me" })),
    );
    expect(saved.outcome).toBe("created");

    await runtime.runPromise(
      Db.use((db) =>
        db
          .delete(conversations)
          .where(eq(conversations.id, source.sourceConversationId))
          .pipe(Effect.orDie),
      ),
    );
    const surviving = await runtime.runPromise(
      MemoryService.use((service) => service.list(userId)),
    );
    expect(surviving[0]).toMatchObject({
      content: "Keep me",
      sourceConversationId: null,
      sourceMessageId: null,
    });
    await expect(
      runtime.runPromise(MemoryService.use((service) => service.listReferenceable(userId))),
    ).resolves.toMatchObject([{ content: "Keep me" }]);

    await runtime.runPromise(
      Db.use((db) => db.delete(user).where(eq(user.id, userId)).pipe(Effect.orDie)),
    );
    const counts = await runtime.runPromise(
      Db.use((db) =>
        Effect.all({
          memories: db
            .select()
            .from(memories)
            .where(eq(memories.userId, userId))
            .pipe(Effect.orDie),
          settings: db
            .select()
            .from(memorySettings)
            .where(eq(memorySettings.userId, userId))
            .pipe(Effect.orDie),
        }),
      ),
    );
    expect(counts).toEqual({ memories: [], settings: [] });
  });

  it("emits changes only when settings or stored rows actually change", async () => {
    published.length = 0;
    const userId = await createUser();
    const service = (effect: (memory: MemoryService["Service"]) => Effect.Effect<unknown>) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const memory = yield* MemoryService;
          return yield* effect(memory);
        }),
      );

    await service((memory) => memory.getSettings(userId));
    await service((memory) =>
      memory.updateSettings(userId, { referenceEnabled: true, autoSaveEnabled: true }),
    );
    await service((memory) => memory.createManual(userId, "One preference"));
    await service((memory) => memory.createManual(userId, "One preference."));

    expect(published).toEqual([{ userId, type: "memory.changed" }]);
  });

  it("does not report a committed mutation as failed when sync publication fails", async () => {
    const userId = await createUser();
    syncShouldFail = true;
    try {
      await expect(
        runtime.runPromise(
          MemoryService.use((service) => service.createManual(userId, "Committed preference")),
        ),
      ).resolves.toMatchObject({ outcome: "created" });
      await expect(
        runtime.runPromise(MemoryService.use((service) => service.list(userId))),
      ).resolves.toMatchObject([{ content: "Committed preference" }]);
    } finally {
      syncShouldFail = false;
    }
  });
});
