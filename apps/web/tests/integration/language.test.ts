import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "~/db/schema/index.ts";
import { LanguageRepo } from "~/modules/language/server/repo.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Db | LanguageRepo, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Db | LanguageRepo>) => runtime.runPromise(effect);

beforeAll(async () => {
  database = await createTestDatabase();
  runtime = ManagedRuntime.make(
    LanguageRepo.layer.pipe(
      Layer.provideMerge(Db.layer),
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 2 })),
    ),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const person = () =>
  run(
    Effect.gen(function* () {
      const id = uuidv7();
      yield* (yield* Db).insert(user).values({ id, name: "Person", email: `${id}@t.io` });
      return id;
    }),
  );

describe("the locale for words sent with no request behind them", () => {
  it("is the choice, else what the browser last asked for, else English", async () => {
    const userId = await person();
    const localeOf = () => run(Effect.flatMap(LanguageRepo, (repo) => repo.localeOf(userId)));
    expect(await localeOf()).toBe("en");

    await run(Effect.flatMap(LanguageRepo, (repo) => repo.noteBrowser(userId, "de")));
    expect(await localeOf()).toBe("de");
    expect(await run(Effect.flatMap(LanguageRepo, (repo) => repo.get(userId)))).toEqual({
      chosen: null,
      region: null,
    });

    await run(Effect.flatMap(LanguageRepo, (repo) => repo.choose(userId, "en")));
    expect(await localeOf()).toBe("en");
    // Following the browser again picks up what it last asked for.
    await run(Effect.flatMap(LanguageRepo, (repo) => repo.choose(userId, null)));
    expect(await localeOf()).toBe("de");
  });

  it("keeps a picked region apart from the language", async () => {
    const userId = await person();
    const get = () => run(Effect.flatMap(LanguageRepo, (repo) => repo.get(userId)));
    await run(Effect.flatMap(LanguageRepo, (repo) => repo.chooseRegion(userId, "CH")));
    await run(Effect.flatMap(LanguageRepo, (repo) => repo.choose(userId, "de")));
    expect(await get()).toEqual({ chosen: "de", region: "CH" });
    await run(Effect.flatMap(LanguageRepo, (repo) => repo.chooseRegion(userId, null)));
    expect(await get()).toEqual({ chosen: "de", region: null });
  });
});
