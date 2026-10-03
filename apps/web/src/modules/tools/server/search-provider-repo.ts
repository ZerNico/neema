import { asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { searchProviders } from "~/db/schema/index.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import {
  SearchProviderSettings,
  type CreateSearchProviderInput,
  type UpdateSearchProviderInput,
} from "../schema.ts";
import type { SearchProviderSnapshot } from "./search-providers/types.ts";

type Row = typeof searchProviders.$inferSelect;

/** A provider row safe for admin clients: ciphertext replaced by a boolean. */
export type PublicSearchProvider = Omit<Row, "secretCiphertext" | "config" | "kind"> & {
  settings: SearchProviderSettings;
  secretConfigured: boolean;
};

export class InvalidSearchProvider extends Schema.TaggedError<InvalidSearchProvider>()(
  "InvalidSearchProvider",
  { reason: Schema.String },
) {}

const decodeSettings = Schema.decodeUnknownEffect(SearchProviderSettings);
const settingsOf = (row: Row) =>
  decodeSettings({ ...row.config, kind: row.kind }).pipe(Effect.orDie);
const configOf = ({ kind: _kind, ...config }: SearchProviderSettings) => config;
const needsSecret = (settings: SearchProviderSettings) => settings.kind !== "searxng";

/**
 * Loads the enabled providers in order with decrypted secrets: the snapshot one
 * generation searches with. Shared with ToolsRepo, which hands it out with the
 * web_search row.
 */
export const loadEnabledSearchProviders = (db: Db["Service"], cipher: KeyCipher["Service"]) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(searchProviders)
      .where(eq(searchProviders.enabled, true))
      .orderBy(asc(searchProviders.position), asc(searchProviders.id))
      .pipe(Effect.orDie);
    return yield* Effect.forEach(rows, (row) => snapshotOf(row, cipher));
  });

const snapshotOf = (row: Row, cipher: KeyCipher["Service"]) =>
  Effect.gen(function* () {
    return {
      id: row.id,
      label: row.label,
      version: row.updatedAt.getTime(),
      settings: yield* settingsOf(row),
      secret: row.secretCiphertext ? yield* cipher.decrypt(row.secretCiphertext) : null,
    } satisfies SearchProviderSnapshot;
  });

const toPublic = (row: Row) =>
  Effect.map(settingsOf(row), (settings): PublicSearchProvider => {
    const { secretCiphertext, config: _config, kind: _kind, ...rest } = row;
    return { ...rest, settings, secretConfigured: secretCiphertext !== null };
  });

const keepTyped = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.catch((error) =>
      error instanceof InvalidSearchProvider ? Effect.fail(error) : Effect.die(error),
    ),
  );

// Serializes order writes with creation, which appends at the end.
const lockOrder = sql`select pg_advisory_xact_lock(hashtextextended('chat.search-provider-order', 0))`;

export class SearchProviderRepo extends Context.Service<
  SearchProviderRepo,
  {
    list(): Effect.Effect<ReadonlyArray<PublicSearchProvider>>;
    /** Internal: one provider with its decrypted secret, enabled or not, for a test. */
    snapshot(id: string): Effect.Effect<SearchProviderSnapshot | null>;
    create(
      input: CreateSearchProviderInput,
    ): Effect.Effect<PublicSearchProvider, InvalidSearchProvider>;
    update(
      input: UpdateSearchProviderInput,
    ): Effect.Effect<PublicSearchProvider | null, InvalidSearchProvider>;
    remove(id: string): Effect.Effect<void>;
    /** Replaces the whole order; `ids` must name every provider once. */
    setOrder(ids: ReadonlyArray<string>): Effect.Effect<void, InvalidSearchProvider>;
  }
>()("chat/tools/SearchProviderRepo") {
  static readonly layer = Layer.effect(
    SearchProviderRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const cipher = yield* KeyCipher;

      const getRow = (id: string) =>
        db
          .select()
          .from(searchProviders)
          .where(eq(searchProviders.id, id))
          .pipe(
            Effect.map((rows) => rows[0] ?? null),
            Effect.orDie,
          );

      return SearchProviderRepo.of({
        list: Effect.fn("SearchProviderRepo.list")(function* () {
          const rows = yield* db
            .select()
            .from(searchProviders)
            .orderBy(asc(searchProviders.position), asc(searchProviders.id))
            .pipe(Effect.orDie);
          return yield* Effect.forEach(rows, toPublic);
        }),

        snapshot: Effect.fn("SearchProviderRepo.snapshot")(function* (id) {
          const row = yield* getRow(id);
          return row ? yield* snapshotOf(row, cipher) : null;
        }),

        create: Effect.fn("SearchProviderRepo.create")(function* (input) {
          const secret = input.secret?.trim() ?? "";
          if (needsSecret(input.settings) && !secret)
            return yield* new InvalidSearchProvider({ reason: "Enter the API key." });
          const secretCiphertext = secret ? yield* cipher.encrypt(secret) : null;
          const row = yield* keepTyped(
            db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.execute(lockOrder);
                const [last] = yield* tx
                  .select({ position: sql<number>`coalesce(max(${searchProviders.position}), -1)` })
                  .from(searchProviders);
                const [inserted] = yield* tx
                  .insert(searchProviders)
                  .values({
                    id: uuidv7(),
                    kind: input.settings.kind,
                    label: input.label.trim(),
                    position: (last?.position ?? -1) + 1,
                    config: configOf(input.settings),
                    secretCiphertext,
                  })
                  .returning();
                return inserted!;
              }),
            ),
          );
          return yield* toPublic(row);
        }),

        update: Effect.fn("SearchProviderRepo.update")(function* (input) {
          const row = yield* getRow(input.id);
          if (!row) return null;
          if (input.settings && input.settings.kind !== row.kind)
            return yield* new InvalidSearchProvider({
              reason: "A provider’s kind can’t change. Add a new provider instead.",
            });
          const settings = input.settings ?? (yield* settingsOf(row));
          const secret = input.secret?.trim() ?? "";
          if (input.clearSecret && needsSecret(settings))
            return yield* new InvalidSearchProvider({
              reason: "This provider needs an API key. Enter a new one instead of clearing it.",
            });
          const secretCiphertext = input.clearSecret
            ? null
            : secret
              ? yield* cipher.encrypt(secret)
              : row.secretCiphertext;
          const [updated] = yield* db
            .update(searchProviders)
            .set({
              ...(input.label !== undefined ? { label: input.label.trim() } : {}),
              ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
              config: configOf(settings),
              secretCiphertext,
              // The database's clock, as at creation: the version must only grow.
              updatedAt: sql`now()`,
            })
            .where(eq(searchProviders.id, input.id))
            .returning()
            .pipe(Effect.orDie);
          return updated ? yield* toPublic(updated) : null;
        }),

        remove: Effect.fn("SearchProviderRepo.remove")(function* (id) {
          yield* db.delete(searchProviders).where(eq(searchProviders.id, id)).pipe(Effect.orDie);
        }),

        setOrder: Effect.fn("SearchProviderRepo.setOrder")(function* (ids) {
          yield* keepTyped(
            db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.execute(lockOrder);
                const existing = yield* tx.select({ id: searchProviders.id }).from(searchProviders);
                const known = new Set(existing.map((row) => row.id));
                if (
                  ids.length !== known.size ||
                  new Set(ids).size !== ids.length ||
                  ids.some((id) => !known.has(id))
                ) {
                  return yield* new InvalidSearchProvider({
                    reason: "The provider list changed. Refresh and try again.",
                  });
                }
                if (ids.length === 0) return;
                // Position only: reordering must not reset a provider's health.
                yield* tx.update(searchProviders).set({
                  position: sql`case ${sql.join(
                    ids.map(
                      (id, index) => sql`when ${searchProviders.id} = ${id} then ${index}::integer`,
                    ),
                    sql` `,
                  )} end`,
                });
              }),
            ),
          );
        }),
      });
    }),
  );
}
