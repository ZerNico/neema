import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { presentationFonts, user } from "~/db/schema/index.ts";
import { PresentationFonts } from "~/modules/presentations/server/fonts.ts";
import {
  FontFetchFailed,
  GoogleFontSource,
  type FetchedFace,
} from "~/modules/presentations/server/google-font-source.ts";
import { PresentationWorkers } from "~/modules/presentations/server/runtime.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { english } from "~/i18n/localized.ts";

const bundled = join(
  dirname(createRequire(import.meta.url).resolve("@office-kit/pptx-preview/package.json")),
  "fonts",
);
const face = (name: string) => new Uint8Array(readFileSync(join(bundled, name)));
const abril = new Uint8Array(
  readFileSync(join(import.meta.dirname, "../fixtures/fonts/AbrilFatface-Regular.ttf")),
);

// Stands in for Google: no test touches the network. Each family answers with
// the faces listed here, and every call is counted.
const served = new Map<string, FetchedFace[]>();
const fetched: string[] = [];
const fakeSource = Layer.succeed(
  GoogleFontSource,
  GoogleFontSource.of({
    fetchFamily: (family) => {
      fetched.push(family);
      const faces = served.get(family);
      return faces ? Effect.succeed(faces) : Effect.fail(new FontFetchFailed({ family }));
    },
  }),
);
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
  runtime = ManagedRuntime.make(
    PresentationFonts.base.pipe(
      Layer.provide([PresentationWorkers.layer, fakeSource]),
      Layer.provideMerge(infrastructure),
    ),
  );
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
  expect(english(junk.reason)).toMatch(/not a TrueType or OpenType/);
  expect(junk.reason("de")).toBe("Das ist keine TrueType- oder OpenType-Schrift.");
  // Valid tables around glyph data the renderer cannot use fail the trial render.
  const broken = face("Carlito-Regular.ttf");
  broken.fill(0, 2000, broken.length);
  const failed = await run(
    fonts.upload({ fileName: "broken.ttf", bytes: broken, userId: admin }).pipe(Effect.flip),
  );
  expect(english(failed.reason)).toBeTruthy();
  expect((await run(fonts.list())).some((font) => font.fileName === "broken.ttf")).toBe(false);
});

it("checks a skill's faces in a worker once per content, and drops one that can't render", async () => {
  const fonts = await run(Effect.flatMap(PresentationFonts, (service) => Effect.succeed(service)));
  const carlito = face("Carlito-Bold.ttf");
  const sha256 = createHash("sha256").update(carlito).digest("hex");
  const broken = carlito.slice(0, 400);
  const faces = await run(
    fonts.skillFaces([
      { sha256, bytes: carlito },
      { sha256: "0".repeat(64), bytes: broken },
      { sha256: "1".repeat(64), bytes: new TextEncoder().encode("not a font at all") },
    ]),
  );
  expect(faces).toEqual([
    expect.objectContaining({ family: "Carlito", bold: true, path: expect.any(String) }),
  ]);
  expect(existsSync(faces[0]!.path)).toBe(true);
  // A second answer loading the same skill reuses the checked face.
  expect(await run(fonts.skillFaces([{ sha256, bytes: carlito }]))).toEqual(faces);
  // Skill faces never join the uploaded catalogue.
  expect(await run(fonts.families())).not.toContain("Carlito");
});

it("fetches a curated family on first use, keeps it out of the admin list, and touches it after", async () => {
  const fonts = await run(Effect.flatMap(PresentationFonts, (service) => Effect.succeed(service)));
  served.set("Abril Fatface", [{ bold: false, italic: false, bytes: abril }]);
  fetched.length = 0;
  // Names that are not in the catalogue are ignored; spelling is normalized.
  await run(fonts.ensure(["abril fatface", "Comic Sans MS"]));
  expect(fetched).toEqual(["Abril Fatface"]);
  expect(await run(fonts.families())).toContain("Abril Fatface");
  expect((await run(fonts.faces())).find((f) => f.family === "Abril Fatface")).toMatchObject({
    source: "google",
  });
  expect((await run(fonts.list())).some((f) => f.family === "Abril Fatface")).toBe(false);

  // Cached: a later edit touches it instead of fetching, once a day at most.
  await run(
    Effect.flatMap(Db, (db) =>
      db
        .update(presentationFonts)
        .set({ lastUsedAt: sql`now() - interval '3 days'` })
        .where(eq(presentationFonts.family, "Abril Fatface")),
    ),
  );
  await run(fonts.ensure(["Abril Fatface"]));
  expect(fetched).toEqual(["Abril Fatface"]);
  const [row] = await run(
    Effect.flatMap(Db, (db) =>
      db
        .select({
          recent: sql<boolean>`${presentationFonts.lastUsedAt} > now() - interval '1 hour'`,
        })
        .from(presentationFonts)
        .where(eq(presentationFonts.family, "Abril Fatface")),
    ),
  );
  expect(row?.recent).toBe(true);
});

it("refuses a fetched face that calls itself something else, and does not retry at once", async () => {
  const fonts = await run(Effect.flatMap(PresentationFonts, (service) => Effect.succeed(service)));
  served.set("Poppins", [{ bold: false, italic: false, bytes: face("Caladea-Regular.ttf") }]);
  fetched.length = 0;
  await run(fonts.ensure(["Poppins"]));
  await run(fonts.ensure(["Poppins"]));
  expect(fetched).toEqual(["Poppins"]);
  expect(await run(fonts.families())).not.toContain("Poppins");
});

it("lets an upload own its family: it replaces fetched styles and stops further fetches", async () => {
  const fonts = await run(Effect.flatMap(PresentationFonts, (service) => Effect.succeed(service)));
  served.set("Abril Fatface", [{ bold: false, italic: false, bytes: abril }]);
  await run(fonts.ensure(["Abril Fatface"]));
  await run(fonts.upload({ fileName: "Abril.ttf", bytes: abril, userId: admin }));
  const rows = await run(
    Effect.flatMap(Db, (db) =>
      db
        .select({ source: presentationFonts.source })
        .from(presentationFonts)
        .where(eq(presentationFonts.family, "Abril Fatface")),
    ),
  );
  expect(rows).toEqual([{ source: "upload" }]);
  fetched.length = 0;
  await run(fonts.ensure(["Abril Fatface"]));
  expect(fetched).toEqual([]);
});

it("sweeps fetched faces unused for two weeks by the database clock, never an upload", async () => {
  const fonts = await run(Effect.flatMap(PresentationFonts, (service) => Effect.succeed(service)));
  // Abril Fatface is an upload by now (previous test). A fetched face beside it,
  // one used recently, and every other row aged past the window.
  const cachedFace = (family: string) => ({
    id: uuidv7(),
    family,
    renderFamily: family,
    style: "Regular",
    bold: false,
    italic: false,
    embeddable: true,
    format: "ttf" as const,
    fileName: `${family}.ttf`,
    byteSize: abril.length,
    sha256: createHash("sha256").update(family).digest("hex"),
    bytes: Buffer.from(abril),
    source: "google" as const,
  });
  await run(
    Effect.flatMap(Db, (db) =>
      db.insert(presentationFonts).values([cachedFace("Bebas Neue"), cachedFace("Oswald")]),
    ),
  );
  await run(
    Effect.flatMap(Db, (db) =>
      db.update(presentationFonts).set({
        lastUsedAt: sql`now() - interval '15 days'`,
        createdAt: sql`now() - interval '15 days'`,
      }),
    ),
  );
  const before = await run(
    Effect.flatMap(Db, (db) =>
      db.select({ source: presentationFonts.source }).from(presentationFonts),
    ),
  );
  expect(before.some((row) => row.source === "upload")).toBe(true);
  await run(
    Effect.flatMap(Db, (db) =>
      db
        .update(presentationFonts)
        .set({ lastUsedAt: sql`now() - interval '13 days'` })
        .where(eq(presentationFonts.family, "Oswald")),
    ),
  );
  expect(await run(fonts.sweep())).toBe(1);
  const after = await run(
    Effect.flatMap(Db, (db) =>
      db
        .select({ family: presentationFonts.family, source: presentationFonts.source })
        .from(presentationFonts),
    ),
  );
  expect(after.some((row) => row.family === "Bebas Neue")).toBe(false);
  expect(after).toContainEqual({ family: "Oswald", source: "google" });
  expect(after.filter((row) => row.source === "upload")).toHaveLength(
    before.filter((row) => row.source === "upload").length,
  );
});
