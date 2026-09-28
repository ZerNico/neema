import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, expect, it } from "vitest";
import { user } from "~/db/schema/index.ts";
import { PresentationFonts } from "~/modules/presentations/server/fonts.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

const bundled = join(
  dirname(createRequire(import.meta.url).resolve("@office-kit/pptx-preview/package.json")),
  "fonts",
);
const face = (name: string) => new Uint8Array(readFileSync(join(bundled, name)));

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Db | PresentationFonts, unknown>;
let admin: string;
const run = <A, E>(effect: Effect.Effect<A, E, Db | PresentationFonts>) =>
  runtime.runPromise(effect);

beforeAll(async () => {
  database = await createTestDatabase();
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 4 })),
  );
  runtime = ManagedRuntime.make(PresentationFonts.layer.pipe(Layer.provideMerge(infrastructure)));
  admin = uuidv7();
  await run(
    Effect.flatMap(Db, (db) =>
      db.insert(user).values({ id: admin, name: "Admin", email: `${admin}@t.io` }),
    ),
  );
});

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

it("accepts a face after a trial render, replaces it by family and style, and removes it", async () => {
  const fonts = await run(Effect.flatMap(PresentationFonts, (service) => Effect.succeed(service)));
  const saved = await run(
    fonts.upload({
      fileName: "Caladea-Regular.ttf",
      bytes: face("Caladea-Regular.ttf"),
      userId: admin,
    }),
  );
  expect(saved).toMatchObject({ family: "Caladea", bold: false, italic: false, embeddable: true });
  await run(
    fonts.upload({ fileName: "Caladea-Bold.ttf", bytes: face("Caladea-Bold.ttf"), userId: admin }),
  );
  const again = await run(
    fonts.upload({ fileName: "renamed.ttf", bytes: face("Caladea-Regular.ttf"), userId: admin }),
  );
  expect(again.id).toBe(saved.id);
  const listed = await run(fonts.list());
  expect(listed.map((font) => [font.family, font.bold, font.fileName])).toEqual([
    ["Caladea", false, "renamed.ttf"],
    ["Caladea", true, "Caladea-Bold.ttf"],
  ]);
  const faces = await run(fonts.faces());
  expect(faces).toHaveLength(2);
  for (const current of faces) expect(existsSync(current.path)).toBe(true);
  expect(await run(fonts.families())).toEqual(expect.arrayContaining(["Calibri", "Caladea"]));

  await run(fonts.remove(saved.id));
  expect((await run(fonts.faces())).map((current) => current.bold)).toEqual([true]);
});

it("rejects files that are not usable fonts with a reason", async () => {
  const fonts = await run(Effect.flatMap(PresentationFonts, (service) => Effect.succeed(service)));
  const junk = await run(
    fonts
      .upload({
        fileName: "notes.ttf",
        bytes: new TextEncoder().encode("not a font at all"),
        userId: admin,
      })
      .pipe(Effect.flip),
  );
  expect(junk.reason).toMatch(/not a TrueType or OpenType/);
  // Valid tables around glyph data the renderer cannot use fail the trial render.
  const broken = face("Carlito-Regular.ttf");
  broken.fill(0, 2000, broken.length);
  const failed = await run(
    fonts.upload({ fileName: "broken.ttf", bytes: broken, userId: admin }).pipe(Effect.flip),
  );
  expect(failed.reason).toBeTruthy();
  expect((await run(fonts.list())).some((font) => font.fileName === "broken.ttf")).toBe(false);
});
