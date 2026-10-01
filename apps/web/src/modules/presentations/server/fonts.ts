import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { presentationFonts } from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";
import { PresentationError } from "../errors.ts";
import { BUNDLED_FONTS, FONT_LIMITS } from "../limits.ts";
import { readFontFile, type FontFace } from "./font-file.ts";
import { PresentationWorkers } from "./runtime.ts";

export class FontRejected extends Schema.TaggedError<FontRejected>()("FontRejected", {
  reason: Schema.String,
}) {}

export interface FontRecord {
  readonly id: string;
  readonly family: string;
  readonly style: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly embeddable: boolean;
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
  fileName: row.fileName,
  byteSize: row.byteSize,
  createdAt: row.createdAt,
});

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
    /** Uploaded faces as local files, for render work. */
    faces(): Effect.Effect<readonly FontFace[]>;
    /** Every family a deck may use: bundled and uploaded. */
    families(): Effect.Effect<readonly string[]>;
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
  static readonly layer = Layer.effect(
    PresentationFonts,
    Effect.gen(function* () {
      const db = yield* Db;
      const workers = yield* PresentationWorkers;
      const cached = yield* Ref.make<readonly FontFace[] | null>(null);
      const columns = {
        id: presentationFonts.id,
        family: presentationFonts.family,
        renderFamily: presentationFonts.renderFamily,
        bold: presentationFonts.bold,
        italic: presentationFonts.italic,
        format: presentationFonts.format,
        sha256: presentationFonts.sha256,
      };

      const faces = Effect.fn("PresentationFonts.faces")(function* () {
        const current = yield* Ref.get(cached);
        // The cache lives in the temporary directory, which the system may clean.
        if (current?.every((face) => existsSync(face.path))) return current;
        const rows = yield* db.select(columns).from(presentationFonts).pipe(Effect.orDie);
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
              },
            ];
          }),
        ).pipe(Effect.map((faces) => faces.flat()));
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
        const reject = (reason: string) => Effect.fail(new FontRejected({ reason }));
        if (bytes.length > FONT_LIMITS.fileBytes)
          return yield* reject(
            `Fonts must be under ${megabytes(FONT_LIMITS.fileBytes)} MB per file.`,
          );
        const info = yield* Effect.try({
          try: () => readFontFile(bytes),
          catch: (error) =>
            new FontRejected({
              reason:
                error instanceof PresentationError ? error.message : "This is not a usable font.",
            }),
        });
        const [usage] = yield* db
          .select({
            count: sql<number>`count(*)::int`,
            bytes: sql<number>`coalesce(sum(${presentationFonts.byteSize}), 0)::int`,
          })
          .from(presentationFonts)
          .where(
            sql`not (${presentationFonts.family} = ${info.family} and ${presentationFonts.bold} = ${info.bold} and ${presentationFonts.italic} = ${info.italic})`,
          )
          .pipe(Effect.orDie);
        if ((usage?.count ?? 0) >= FONT_LIMITS.faces)
          return yield* reject(`At most ${FONT_LIMITS.faces} font faces can be uploaded.`);
        if ((usage?.bytes ?? 0) + bytes.length > FONT_LIMITS.totalBytes)
          return yield* reject(
            `Uploaded fonts are limited to ${megabytes(FONT_LIMITS.totalBytes)} MB in total.`,
          );
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const fresh = !existsSync(cachePath(sha256, info.format));
        const path = yield* Effect.promise(() => materialize(sha256, info.format, bytes));
        // The trial render runs in a pool worker, so a font that hangs or
        // crashes the renderer fails here and costs only that worker.
        yield* Effect.tryPromise({
          try: () => workers.run({ kind: "font", path }),
          catch: () =>
            new FontRejected({ reason: "The renderer could not draw text with this font." }),
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
          createdBy: userId,
        };
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
          return { family, renderFamily, bold, italic, path };
        })();
        if (checked.size >= FONT_LIMITS.faces * 4) checked.delete(checked.keys().next().value!);
        checked.set(sha256, result);
        return result;
      };

      return PresentationFonts.of({
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
              fileName: presentationFonts.fileName,
              byteSize: presentationFonts.byteSize,
              createdAt: presentationFonts.createdAt,
            })
            .from(presentationFonts)
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
        faces,
        families: Effect.fn("PresentationFonts.families")(function* () {
          const uploaded = (yield* faces()).map((face) => face.family);
          return [...new Set([...BUNDLED_FONTS, ...uploaded])];
        }),
      });
    }),
  ).pipe(Layer.provide(PresentationWorkers.layer));
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
