import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { searchProviders } from "~/db/schema/index.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import {
  InvalidSearchProvider,
  SearchProviderRepo,
} from "~/modules/tools/server/search-provider-repo.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");
let database: TestDatabase;
type Services = SearchProviderRepo | ToolsRepo | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
const runFailure = <A, E>(effect: Effect.Effect<A, E, Services>) => run(Effect.flip(effect));

beforeAll(async () => {
  database = await createTestDatabase();
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 5 })),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(SearchProviderRepo.layer, ToolsRepo.layer).pipe(
      Layer.provideMerge(KeyCipher.layer),
      Layer.provideMerge(infra),
    ),
  );
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

beforeEach(async () => {
  // This file owns its disposable database.
  await run(Effect.flatMap(Db, (db) => db.delete(searchProviders)));
});

const create = (label: string, kind: "searxng" | "tavily" = "tavily", secret = "tvly-secret") =>
  run(
    Effect.gen(function* () {
      const repo = yield* SearchProviderRepo;
      return yield* repo.create({
        label,
        settings: kind === "searxng" ? { kind, baseUrl: "http://searx" } : { kind },
        ...(secret ? { secret } : {}),
      });
    }),
  );

describe("SearchProviderRepo", () => {
  it("appends in order, encrypts keys and never returns them", async () => {
    const first = await create("Home", "searxng", "");
    const second = await create("Tavily one");
    const third = await create("Tavily two", "tavily", "tvly-other");
    expect([first.position, second.position, third.position]).toEqual([0, 1, 2]);
    expect(first.secretConfigured).toBe(false);
    expect(second.secretConfigured).toBe(true);
    expect(JSON.stringify(await run(SearchProviderRepo.use((repo) => repo.list())))).not.toContain(
      "tvly-",
    );
    const rows = await run(Effect.flatMap(Db, (db) => db.select().from(searchProviders)));
    expect(rows.find((row) => row.id === second.id)?.secretCiphertext).not.toContain("tvly-");

    const tool = await run(ToolsRepo.use((repo) => repo.getWebSearch()));
    expect(tool?.providers.map((provider) => provider.label)).toEqual([
      "Home",
      "Tavily one",
      "Tavily two",
    ]);
    expect(Redacted.value(tool!.providers[1]!.secret!)).toBe("tvly-secret");
    expect(tool!.providers[0]!.settings).toEqual({ kind: "searxng", baseUrl: "http://searx" });
  });

  it("requires a key for hosted providers and refuses to clear one", async () => {
    const missing = await runFailure(
      SearchProviderRepo.use((repo) => repo.create({ label: "T", settings: { kind: "tavily" } })),
    );
    expect(missing.reason).toBe("Enter the API key.");
    const created = await create("T");
    const cleared = await runFailure(
      SearchProviderRepo.use((repo) => repo.update({ id: created.id, clearSecret: true })),
    );
    expect(cleared).toBeInstanceOf(InvalidSearchProvider);
    const kind = await runFailure(
      SearchProviderRepo.use((repo) =>
        repo.update({ id: created.id, settings: { kind: "brave" } }),
      ),
    );
    expect(kind).toBeInstanceOf(InvalidSearchProvider);
  });

  it("keeps a stored key on an empty secret and bumps the version on edits", async () => {
    const created = await create("T");
    const updated = await run(
      SearchProviderRepo.use((repo) =>
        repo.update({ id: created.id, label: "Renamed", secret: "" }),
      ),
    );
    expect(updated?.label).toBe("Renamed");
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    const snapshot = await run(SearchProviderRepo.use((repo) => repo.snapshot(created.id)));
    expect(Redacted.value(snapshot!.secret!)).toBe("tvly-secret");
  });

  it("leaves disabled providers out of the execution snapshot", async () => {
    const off = await create("Off");
    await create("On");
    await run(SearchProviderRepo.use((repo) => repo.update({ id: off.id, enabled: false })));
    const tool = await run(ToolsRepo.use((repo) => repo.getWebSearch()));
    expect(tool?.providers.map((provider) => provider.label)).toEqual(["On"]);
  });

  it("replaces the whole order without touching versions, and refuses a stale list", async () => {
    const a = await create("A");
    const b = await create("B");
    const c = await create("C");
    await run(SearchProviderRepo.use((repo) => repo.setOrder([c.id, a.id, b.id])));
    const listed = await run(SearchProviderRepo.use((repo) => repo.list()));
    expect(listed.map((provider) => provider.label)).toEqual(["C", "A", "B"]);
    expect(listed.find((provider) => provider.id === a.id)?.updatedAt).toEqual(a.updatedAt);

    const stale = await runFailure(SearchProviderRepo.use((repo) => repo.setOrder([a.id, b.id])));
    expect(stale).toBeInstanceOf(InvalidSearchProvider);
    await run(SearchProviderRepo.use((repo) => repo.remove(b.id)));
    expect(
      (await run(SearchProviderRepo.use((repo) => repo.list()))).map((provider) => provider.label),
    ).toEqual(["C", "A"]);
  });
});
