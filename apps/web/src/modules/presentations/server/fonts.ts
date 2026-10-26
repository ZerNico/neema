import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Ref, Schedule, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { presentationFonts } from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";
import { PresentationError } from "../errors.ts";
import { BUNDLED_FONTS, FONT_LIMITS } from "../limits.ts";
import { googleFontFamily, type GoogleFontFamily } from "../google-fonts.ts";
import { readFontFile, type FontFace, type FontRefusal } from "./font-file.ts";
import { GoogleFontSource } from "./google-font-source.ts";
import { PresentationWorkers } from "./runtime.ts";
import { m } from "~/paraglide/messages.js";
import { localized, Localized as LocalizedSchema, type Localized } from "~/i18n/localized.ts";

/** A failed fetch is remembered this long, so an offline server does not stall every edit. */
const FETCH_RETRY_MS = 10 * 60 * 1000;
/** Fetched faces no deck has used this long are dropped; the next use fetches them again. */
const FETCHED_FONT_TTL_DAYS = 14;
const SWEEP_EVERY = Duration.hours(6);

export class FontRejected extends Schema.TaggedError<FontRejected>()("FontRejected", {
  reason: LocalizedSchema,
}) {}

/** What an admin reads for a font the parser refused, by the refusal's code. */
const FONT_REFUSALS: Record<FontRefusal, Localized> = {
  invalid_font: localized(m.presentations_font_error_damaged),
  not_a_font: localized(m.presentations_font_error_not_a_font),
  font_collection: localized(m.presentations_font_error_collection),
  web_font: localized(m.presentations_font_error_web_font),
  variable_font: localized(m.presentations_font_error_variable_cff2),
};
const fontRefusal = (error: unknown) =>
  error instanceof PresentationError && error.code in FONT_REFUSALS
    ? FONT_REFUSALS[error.code as FontRefusal]
    : localized(m.presentations_font_error_unusable);

export interface FontRecord {
  readonly id: string;
  readonly family: string;
  readonly style: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly embeddable: boolean;
  /** Whether decks that use it carry it; only an embeddable face can. */
  readonly embed: boolean;
  readonly fileName: string;
  readonly byteSize: number;
  readonly createdAt: Date;
}

// Faces are written once per content hash; the renderer needs file paths.
const cacheDirectory = join(tmpdir(), "chat-presentation-fonts");
const cachePath = (sha256: string, format: string) => join(cacheDirectory, `${sha256}.${format}`);
async function materialize(sha256: string, format: string, bytes: Uint8Array) {
  const path = cachePath(sha256, format);
  if (existsSync(path)) return path;
  await mkdir(cacheDirectory, { recursive: true });
  const temporary = `${path}.${uuidv7()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  return path;
}

export const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);

const record = (row: typeof presentationFonts.$inferSelect): FontRecord => ({
  id: row.id,
  family: row.family,
  style: row.style,
  bold: row.bold,
  italic: row.italic,
  embeddable: row.embeddable,
  embed: row.embed,
  fileName: row.fileName,
  byteSize: row.byteSize,
  createdAt: row.createdAt,
});

const reject = (reason: Localized) => Effect.fail(new FontRejected({ reason }));

/**
 * Font faces an admin uploaded, shared by every presentation render. A face is
 * accepted only after the renderer has drawn a sample with it in a worker, so
 * one broken upload cannot take every preview down with it.
 */
export class PresentationFonts extends Context.Service<
  PresentationFonts,
  {
    list(): Effect.Effect<FontRecord[]>;
    upload(input: {
      fileName: string;
      bytes: Uint8Array;
      userId: string;
    }): Effect.Effect<FontRecord, FontRejected>;
    remove(id: string): Effect.Effect<void>;
    /** An admin's choice to embed an uploaded face in decks; refused for one whose licence forbids it. */
    setEmbed(id: string, embed: boolean): Effect.Effect<void, FontRejected>;
    /** Uploaded faces as local files, for render work. */
    faces(): Effect.Effect<readonly FontFace[]>;
    /** Every family a deck may use now: bundled, uploaded and fetched. */
    families(): Effect.Effect<readonly string[]>;
    /**
     * Makes curated Google families a deck names available: fetched and
     * checked on first use, their last use touched after that. Other names are
     * ignored. A family an admin uploaded any face of is never fetched.
     */
    ensure(families: ReadonlyArray<string>): Effect.Effect<void>;
    /** Drops fetched faces unused for two weeks, by the database clock; returns how many. */
    sweep(): Effect.Effect<number>;
    /**
     * Faces a skill carries, for the answers that loaded it. Each is checked
     * once per content hash, in a worker process, like an upload; one the
     * renderer can't use is left out, never failing the render.
     */
    skillFaces(
      fonts: ReadonlyArray<{ readonly sha256: string; readonly bytes: Uint8Array }>,
    ): Effect.Effect<readonly FontFace[]>;
  }
>()("chat/presentations/PresentationFonts") {
  /** Without a font source, so tests can supply one that never touches the network. */
  static readonly base = Layer.effect(
    PresentationFonts,
    Effect.gen(function* () {
      const db = yield* Db;
      const workers = yield* PresentationWorkers;
      const source = yield* GoogleFontSource;
      const context = yield* Effect.context<never>();
      const cached = yield* Ref.make<readonly FontFace[] | null>(null);
      const columns = {
        id: presentationFonts.id,
        family: presentationFonts.family,
        renderFamily: presentationFonts.renderFamily,
        bold: presentationFonts.bold,
        italic: presentationFonts.italic,
        format: presentationFonts.format,
        sha256: presentationFonts.sha256,
        source: presentationFonts.source,
        embeddable: presentationFonts.embeddable,
        embed: presentationFonts.embed,
      };

      const faces = Effect.fn("PresentationFonts.faces")(function* () {
        const current = yield* Ref.get(cached);
        // The cache lives in the temporary directory, which the system may clean.
        if (current?.every((face) => existsSync(face.path))) return current;
        // Ordered, so the hash of the list changes only when the faces do.
        const rows = yield* db
          .select(columns)
          .from(presentationFonts)
          .orderBy(
            asc(presentationFonts.family),
            asc(presentationFonts.bold),
            asc(presentationFonts.italic),
          )
          .pipe(Effect.orDie);
        const loaded = yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            let path = cachePath(row.sha256, row.format);
            if (!existsSync(path)) {
              const [stored] = yield* db
                .select({ bytes: presentationFonts.bytes })
                .from(presentationFonts)
                .where(eq(presentationFonts.id, row.id))
                .pipe(Effect.orDie);
              if (!stored) return [];
              path = yield* Effect.promise(() => materialize(row.sha256, row.format, stored.bytes));
            }
            return [
              {
                family: row.family,
                renderFamily: row.renderFamily,
                bold: row.bold,
                italic: row.italic,
                path,
                source: row.source,
                // Google faces are licensed for embedding; an upload only by choice.
                embed: row.embeddable && (row.source === "google" || row.embed),
              },
            ];
          }),
        ).pipe(Effect.map((groups) => groups.flat()));
        yield* Ref.set(cached, loaded);
        return loaded;
      });

      const upload = Effect.fn("PresentationFonts.upload")(function* ({
        fileName,
        bytes,
        userId,
      }: {
        fileName: string;
        bytes: Uint8Array;
        userId: string;
      }) {
        if (bytes.length > FONT_LIMITS.fileBytes)
          return yield* reject(
            localized(m.presentations_font_error_file_too_large, {
              size: megabytes(FONT_LIMITS.fileBytes),
            }),
          );
        const info = yield* Effect.try({
          try: () => readFontFile(bytes),
          catch: (error) => new FontRejected({ reason: fontRefusal(error) }),
        });
        const [usage] = yield* db
          .select({
            count: sql<number>`count(*)::int`,
            bytes: sql<number>`coalesce(sum(${presentationFonts.byteSize}), 0)::int`,
          })
          .from(presentationFonts)
          .where(
            and(
              eq(presentationFonts.source, "upload"),
              sql`not (${presentationFonts.family} = ${info.family} and ${presentationFonts.bold} = ${info.bold} and ${presentationFonts.italic} = ${info.italic})`,
            ),
          )
          .pipe(Effect.orDie);
        if ((usage?.count ?? 0) >= FONT_LIMITS.faces)
          return yield* reject(
            localized(m.presentations_font_error_too_many, { count: FONT_LIMITS.faces }),
          );
        if ((usage?.bytes ?? 0) + bytes.length > FONT_LIMITS.totalBytes)
          return yield* reject(
            localized(m.presentations_font_error_total_too_large, {
              size: megabytes(FONT_LIMITS.totalBytes),
            }),
          );
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const fresh = !existsSync(cachePath(sha256, info.format));
        const path = yield* Effect.promise(() => materialize(sha256, info.format, bytes));
        // The trial render runs in a pool worker, so a font that hangs or
        // crashes the renderer fails here and costs only that worker.
        yield* Effect.tryPromise({
          try: () => workers.run({ kind: "font", path }),
          catch: () => new FontRejected({ reason: localized(m.presentations_font_error_render) }),
        }).pipe(
          Effect.tapError(() =>
            fresh ? Effect.promise(() => rm(path, { force: true })) : Effect.void,
          ),
        );
        const values = {
          family: info.family,
          renderFamily: info.renderFamily,
          style: info.style,
          bold: info.bold,
          italic: info.italic,
          embeddable: info.embeddable,
          format: info.format,
          fileName: fileName.slice(0, 200),
          byteSize: bytes.length,
          sha256,
          bytes: Buffer.from(bytes),
          source: "upload" as const,
          lastUsedAt: null,
          createdBy: userId,
        };
        // An upload owns its family: fetched styles of it would mix two designs.
        yield* db
          .delete(presentationFonts)
          .where(
            and(
              eq(presentationFonts.source, "google"),
              sql`lower(${presentationFonts.family}) = lower(${info.family})`,
            ),
          )
          .pipe(Effect.orDie);
        const [row] = yield* db
          .insert(presentationFonts)
          .values({ id: uuidv7(), ...values })
          .onConflictDoUpdate({
            target: [presentationFonts.family, presentationFonts.bold, presentationFonts.italic],
            set: { ...values, createdAt: new Date() },
          })
          .returning()
          .pipe(Effect.orDie);
        yield* Ref.set(cached, null);
        return record(row!);
      });

      // Content-addressed: a face is checked once however many answers load it.
      const checked = new Map<string, Promise<FontFace | null>>();
      const skillFace = (sha256: string, bytes: Uint8Array): Promise<FontFace | null> => {
        const known = checked.get(sha256);
        if (known) return known;
        const signature = String.fromCharCode(...bytes.subarray(0, 4));
        const format =
          signature === "OTTO"
            ? "otf"
            : signature === "true" || signature === "\0\x01\0\0"
              ? "ttf"
              : null;
        const result = (async () => {
          if (!format || bytes.length > FONT_LIMITS.fileBytes) return null;
          const path = await materialize(sha256, format, bytes);
          // The whole check, tables and a trial render, runs in a worker process.
          const info = await workers.run({ kind: "font", path }).catch(() => null);
          if (!info) return null;
          const { family, renderFamily, bold, italic } = info;
          return { family, renderFamily, bold, italic, path, source: "skill" as const };
        })();
        if (checked.size >= FONT_LIMITS.faces * 4) checked.delete(checked.keys().next().value!);
        checked.set(sha256, result);
        return result;
      };

      const fetchFamily = Effect.fn("PresentationFonts.fetchFamily")(function* (
        family: GoogleFontFamily,
      ) {
        const fetched = yield* source.fetchFamily(family);
        let stored = 0;
        for (const face of fetched) {
          // The tables are measured as for an upload, and the face must call
          // itself what the catalogue asked for.
          let info;
          try {
            info = readFontFile(face.bytes);
          } catch {
            continue;
          }
          if (
            info.format !== "ttf" ||
            info.family.toLowerCase() !== family.toLowerCase() ||
            info.bold !== face.bold ||
            info.italic !== face.italic
          )
            continue;
          const sha256 = createHash("sha256").update(face.bytes).digest("hex");
          // Drawn once in a worker like any other face before every deck may use it.
          const path = yield* Effect.promise(() => materialize(sha256, info.format, face.bytes));
          const drawn = yield* Effect.tryPromise(() => workers.run({ kind: "font", path })).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!drawn) continue;
          const inserted = yield* db
            .insert(presentationFonts)
            .values({
              id: uuidv7(),
              family: info.family,
              renderFamily: info.renderFamily,
              style: info.style,
              bold: info.bold,
              italic: info.italic,
              embeddable: info.embeddable,
              format: info.format,
              fileName: `${family} ${info.style}.ttf`,
              byteSize: face.bytes.length,
              sha256,
              bytes: Buffer.from(face.bytes),
              source: "google",
              lastUsedAt: sql`now()`,
            })
            // An upload of the same face, or a concurrent fetch, keeps its row.
            .onConflictDoNothing()
            .returning({ id: presentationFonts.id })
            .pipe(Effect.orDie);
          stored += inserted.length;
        }
        return stored;
      });

      const failedUntil = new Map<GoogleFontFamily, number>();
      const ensureFamily = Effect.fn("PresentationFonts.ensureFamily")(function* (
        family: GoogleFontFamily,
      ) {
        const rows = yield* db
          .select({ source: presentationFonts.source })
          .from(presentationFonts)
          .where(sql`lower(${presentationFonts.family}) = lower(${family})`)
          .pipe(Effect.orDie);
        if (rows.some((row) => row.source === "upload")) return;
        if (rows.length) {
          // Throttled, so a busy deck does not write on every render.
          yield* db
            .update(presentationFonts)
            .set({ lastUsedAt: sql`now()` })
            .where(
              and(
                eq(presentationFonts.source, "google"),
                sql`lower(${presentationFonts.family}) = lower(${family})`,
                sql`(${presentationFonts.lastUsedAt} is null or ${presentationFonts.lastUsedAt} < now() - interval '1 day')`,
              ),
            )
            .pipe(Effect.orDie);
          return;
        }
        if ((failedUntil.get(family) ?? 0) > Date.now()) return;
        const stored = yield* fetchFamily(family).pipe(Effect.orElseSucceed(() => 0));
        if (stored === 0) failedUntil.set(family, Date.now() + FETCH_RETRY_MS);
        else {
          failedUntil.delete(family);
          yield* Ref.set(cached, null);
        }
      });

      // One fetch per family at a time, however many edits ask for it at once.
      const inFlight = new Map<GoogleFontFamily, Promise<void>>();
      const ensureOnce = (family: GoogleFontFamily) =>
        Effect.promise(() => {
          const running = inFlight.get(family);
          if (running) return running;
          const started = Effect.runPromiseWith(context)(ensureFamily(family)).finally(() =>
            inFlight.delete(family),
          );
          inFlight.set(family, started);
          return started;
        });

      const sweep = Effect.fn("PresentationFonts.sweep")(function* () {
        const removed = yield* db
          .delete(presentationFonts)
          .where(
            and(
              eq(presentationFonts.source, "google"),
              sql`coalesce(${presentationFonts.lastUsedAt}, ${presentationFonts.createdAt}) < now() - make_interval(days => ${FETCHED_FONT_TTL_DAYS})`,
            ),
          )
          .returning({ id: presentationFonts.id })
          .pipe(Effect.orDie);
        // Their files stay in the temporary cache until the system cleans it;
        // nothing reads a path whose row is gone.
        if (removed.length) yield* Ref.set(cached, null);
        return removed.length;
      });

      yield* sweep().pipe(
        Effect.catchCause((cause) => Effect.logError("fetched font sweep failed", cause)),
        Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
        Effect.forkScoped,
      );

      return PresentationFonts.of({
        sweep,
        ensure: Effect.fn("PresentationFonts.ensure")(function* (names) {
          const families = [...new Set(names.flatMap((name) => googleFontFamily(name) ?? []))];
          yield* Effect.forEach(families, ensureOnce, { concurrency: 4, discard: true });
        }),
        skillFaces: Effect.fn("PresentationFonts.skillFaces")(function* (fonts) {
          const checkedFaces = yield* Effect.promise(() =>
            Promise.all(fonts.map((font) => skillFace(font.sha256, font.bytes))),
          );
          return checkedFaces.filter((face): face is FontFace => face !== null);
        }),
        list: Effect.fn("PresentationFonts.list")(function* () {
          const rows = yield* db
            .select({
              id: presentationFonts.id,
              family: presentationFonts.family,
              style: presentationFonts.style,
              bold: presentationFonts.bold,
              italic: presentationFonts.italic,
              embeddable: presentationFonts.embeddable,
              embed: presentationFonts.embed,
              fileName: presentationFonts.fileName,
              byteSize: presentationFonts.byteSize,
              createdAt: presentationFonts.createdAt,
            })
            .from(presentationFonts)
            // Fetched faces are a cache, not something an admin manages.
            .where(eq(presentationFonts.source, "upload"))
            .orderBy(
              asc(presentationFonts.family),
              asc(presentationFonts.bold),
              asc(presentationFonts.italic),
            )
            .pipe(Effect.orDie);
          return rows;
        }),
        upload,
        remove: Effect.fn("PresentationFonts.remove")(function* (id: string) {
          yield* db
            .delete(presentationFonts)
            .where(eq(presentationFonts.id, id))
            .pipe(Effect.orDie);
          yield* Ref.set(cached, null);
        }),
        setEmbed: Effect.fn("PresentationFonts.setEmbed")(function* (id: string, embed: boolean) {
          const [row] = yield* db
            .update(presentationFonts)
            .set({ embed })
            .where(
              and(
                eq(presentationFonts.id, id),
                eq(presentationFonts.source, "upload"),
                embed ? eq(presentationFonts.embeddable, true) : sql`true`,
              ),
            )
            .returning({ id: presentationFonts.id })
            .pipe(Effect.orDie);
          if (!row)
            return yield* Effect.fail(
              new FontRejected({
                reason: localized(m.presentations_font_error_embed_forbidden),
              }),
            );
          yield* Ref.set(cached, null);
        }),
        faces,
        families: Effect.fn("PresentationFonts.families")(function* () {
          const uploaded = (yield* faces()).map((face) => face.family);
          return [...new Set([...BUNDLED_FONTS, ...uploaded])];
        }),
      });
    }),
  );

  static readonly layer = PresentationFonts.base.pipe(
    Layer.provide([PresentationWorkers.layer, GoogleFontSource.layer]),
  );
}

/**
 * What a drawing's cache key needs of the uploaded faces: a hash of them, so a
 * new or removed face draws afresh. Empty where no fonts service runs.
 */
export const drawnFontsKey = Effect.serviceOption(PresentationFonts).pipe(
  Effect.flatMap((service) =>
    service._tag === "Some" ? service.value.faces() : Effect.succeed([] as const),
  ),
  Effect.map((faces) => createHash("sha256").update(JSON.stringify(faces)).digest("hex")),
);
