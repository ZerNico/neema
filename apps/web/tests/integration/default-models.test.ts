import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { models, providers, user } from "~/db/schema/index.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 7).toString("base64");
let database: TestDatabase;
type Services = ProviderRepo | GroupRepo | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(ProviderRepo.layer, GroupRepo.layer).pipe(
      Layer.provideMerge(KeyCipher.layer),
      Layer.provideMerge(infra),
    ),
  );
  await run(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.insert(user).values([
        { id: "regular", name: "Regular", email: "regular@t.io", role: "user" },
        { id: "member", name: "Member", email: "member@t.io", role: "user" },
        { id: "admin", name: "Admin", email: "admin@t.io", role: "admin" },
      ]);
    }),
  );
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

beforeEach(async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* Db;
      // This file owns its disposable database; provider deletion cascades models.
      yield* db.delete(providers);
      yield* db.insert(providers).values([
        {
          id: "p",
          name: "Provider",
          kind: "openrouter",
          baseUrl: "http://unused",
          apiKeyCiphertext: "unused",
        },
        {
          id: "off",
          name: "Disabled",
          kind: "openrouter",
          baseUrl: "http://unused",
          apiKeyCiphertext: "unused",
          enabled: false,
        },
      ]);
      yield* db.insert(models).values([
        { id: "a", providerId: "p", modelKey: "a", displayName: "Alpha", type: "chat" },
        {
          id: "b",
          providerId: "p",
          modelKey: "b",
          displayName: "Beta",
          type: "chat",
          access: "groups",
        },
        { id: "c", providerId: "p", modelKey: "c", displayName: "Charlie", type: "chat" },
        {
          id: "d",
          providerId: "p",
          modelKey: "d",
          displayName: "Disabled model",
          type: "chat",
          enabled: false,
        },
        {
          id: "e",
          providerId: "off",
          modelKey: "e",
          displayName: "Disabled provider",
          type: "chat",
        },
        {
          id: "embed",
          providerId: "p",
          modelKey: "embed",
          displayName: "Embedding",
          type: "embedding",
        },
      ]);
    }),
  );
});

const visible = (userId = "regular") =>
  ProviderRepo.pipe(Effect.flatMap((repo) => repo.listChatModelsFor(userId)));
const setOrder = (ids: string[]) =>
  ProviderRepo.pipe(Effect.flatMap((repo) => repo.setDefaultModelOrder(ids)));
const winner = (userId = "regular") =>
  visible(userId).pipe(Effect.map((rows) => rows.find((row) => row.isDefault)?.id));
const ranked = ProviderRepo.pipe(
  Effect.flatMap((repo) => repo.listModels()),
  Effect.map((rows) =>
    rows
      .filter((row) => row.defaultPriority !== null)
      // oxlint-disable-next-line unicorn/no-array-sort -- isolated filtered array, ES2022 target
      .sort((a, b) => a.defaultPriority! - b.defaultPriority!)
      .map((row) => ({ id: row.id, priority: row.defaultPriority })),
  ),
);

describe("default model priority", () => {
  it("resolves after group authorization and keeps public fields and display order", async () => {
    await run(
      Effect.gen(function* () {
        const groups = yield* GroupRepo;
        const repo = yield* ProviderRepo;
        const group = yield* groups.createGroup("Priority members");
        yield* groups.addMember(group.id, "member");
        yield* repo.updateModelAccess("b", "groups", [group.id]);
        yield* setOrder(["b", "c", "a"]);
        expect(yield* winner("regular")).toBe("c");
        expect(yield* winner("member")).toBe("b");
        expect(yield* winner("admin")).toBe("b");
        const rows = yield* visible();
        expect(rows.map((row) => row.id)).toEqual(["a", "c"]);
        expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
        expect(new Set(Object.keys(rows[0]!))).toEqual(
          new Set([
            "capabilities",
            "contextLength",
            "description",
            "displayName",
            "id",
            "isDefault",
            "providerName",
            "reasoningEfforts",
          ]),
        );
      }),
    );
  });

  it("retains disabled ranks but skips unavailable models and providers", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* setOrder(["e", "d", "b", "c"]);
        expect(yield* winner()).toBe("c");
        yield* db.update(models).set({ enabled: true }).where(eq(models.id, "d"));
        expect(yield* winner()).toBe("d");
        yield* db.update(providers).set({ enabled: true }).where(eq(providers.id, "off"));
        expect(yield* winner()).toBe("e");
      }),
    );
  });

  it("falls back alphabetically, clears order, and handles no eligible models", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* setOrder(["b"]);
        expect(yield* winner()).toBe("a");
        yield* setOrder(["c"]);
        expect(yield* winner()).toBe("c");
        yield* setOrder([]);
        expect(yield* ranked).toEqual([]);
        expect(yield* winner()).toBe("a");
        yield* db.update(models).set({ displayName: "Same" });
        expect((yield* visible()).map((row) => row.id)).toEqual(["a", "c"]);
        expect(yield* winner()).toBe("a");
        yield* db.update(providers).set({ enabled: false });
        expect(yield* visible()).toEqual([]);
      }),
    );
  });

  it.each([["missing"], ["embed"], ["c", "c"]])(
    "rejects invalid saves atomically: %j",
    async (...ids) => {
      await run(setOrder(["c", "a"]));
      const failure = await run(setOrder(ids).pipe(Effect.flip));
      expect(failure.reason).toBeTruthy();
      expect(await run(ranked)).toEqual([
        { id: "c", priority: 0 },
        { id: "a", priority: 1 },
      ]);
    },
  );

  it("removes deleted models naturally and preserves rank until conversion to embedding", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* ProviderRepo;
        yield* setOrder(["c", "a"]);
        const settings = {
          displayName: "Renamed",
          contextLength: null,
          enabled: true,
          access: "public" as const,
          groupIds: [],
          embeddingDimensions: null,
          pricing: null,
        };
        yield* repo.updateModel("c", {
          ...settings,
          type: "chat",
          capabilities: { reasoning: false, tools: false, vision: false, files: false },
        });
        expect((yield* repo.getModel("c"))?.defaultPriority).toBe(0);
        yield* repo.updateModel("c", {
          ...settings,
          type: "embedding",
          capabilities: { reasoning: false, tools: false, vision: false, files: false },
        });
        expect((yield* repo.getModel("c"))?.defaultPriority).toBeNull();
        expect(yield* winner()).toBe("a");
        yield* repo.deleteModel("a");
        expect(yield* ranked).toEqual([]);
        expect(yield* visible()).toEqual([]);
      }),
    );
  });

  it.each([[], ["a", "c"]])("serializes whole-list replacements from %j", async (...initial) => {
    await run(setOrder(initial));
    await run(
      Effect.all([setOrder(["c", "b"]), setOrder(["a"]), setOrder([])], {
        concurrency: "unbounded",
      }),
    );
    const result = await run(ranked);
    expect([
      [
        { id: "c", priority: 0 },
        { id: "b", priority: 1 },
      ],
      [{ id: "a", priority: 0 }],
      [],
    ]).toContainEqual(result);
  });
});

describe("the utility model", () => {
  const repo = ProviderRepo;
  it("accepts a chat model, refuses others, and clears when its model goes", async () => {
    expect(await run(Effect.flatMap(repo, (r) => r.getUtilityModelId()))).toBeNull();
    await run(Effect.flatMap(repo, (r) => r.setUtilityModelId("c")));
    expect(await run(Effect.flatMap(repo, (r) => r.getUtilityModelId()))).toBe("c");
    const refused = await run(
      Effect.flatMap(repo, (r) => r.setUtilityModelId("embed")).pipe(Effect.flip),
    );
    expect(refused._tag).toBe("InvalidUtilityModel");
    expect(await run(Effect.flatMap(repo, (r) => r.getUtilityModelId()))).toBe("c");
    await run(Effect.flatMap(Db, (db) => db.delete(models).where(eq(models.id, "c"))));
    expect(await run(Effect.flatMap(repo, (r) => r.getUtilityModelId()))).toBeNull();
  });
});
