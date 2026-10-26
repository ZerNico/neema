import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { languageSettings } from "~/db/schema/index.ts";
import { baseLocale, isLocale, type Locale } from "~/paraglide/runtime.js";
import { Db } from "~/server/db.ts";
import type { LanguageChoice, LanguageSetting, RegionChoice } from "../schema.ts";

// A locale this build no longer ships reads as none.
const known = (value: string | null | undefined) => (isLocale(value) ? value : null);

export class LanguageRepo extends Context.Service<
  LanguageRepo,
  {
    get(userId: string): Effect.Effect<LanguageSetting>;
    choose(userId: string, chosen: LanguageChoice): Effect.Effect<void>;
    chooseRegion(userId: string, region: RegionChoice): Effect.Effect<void>;
    /** Records what the browser asked for, read only while nothing is chosen. */
    noteBrowser(userId: string, browser: Locale): Effect.Effect<void>;
    /** The locale for words sent with no request behind them, like a schedule's mail. */
    localeOf(userId: string): Effect.Effect<Locale>;
  }
>()("chat/language/LanguageRepo") {
  static readonly layer = Layer.effect(
    LanguageRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const row = (userId: string) =>
        db
          .select()
          .from(languageSettings)
          .where(eq(languageSettings.userId, userId))
          .pipe(
            Effect.map(([found]) => found),
            Effect.orDie,
          );
      const upsert = (
        userId: string,
        set: { chosen?: LanguageChoice; browser?: Locale; region?: RegionChoice },
      ) =>
        db
          .insert(languageSettings)
          .values({ userId, ...set })
          .onConflictDoUpdate({
            target: languageSettings.userId,
            set: { ...set, updatedAt: sql`now()` },
          })
          .pipe(Effect.asVoid, Effect.orDie);
      return LanguageRepo.of({
        get: Effect.fn("LanguageRepo.get")(function* (userId) {
          const found = yield* row(userId);
          return { chosen: known(found?.chosen), region: found?.region ?? null };
        }),
        choose: (userId, chosen) => upsert(userId, { chosen }),
        chooseRegion: (userId, region) => upsert(userId, { region }),
        noteBrowser: (userId, browser) => upsert(userId, { browser }),
        localeOf: Effect.fn("LanguageRepo.localeOf")(function* (userId) {
          const found = yield* row(userId);
          return known(found?.chosen) ?? known(found?.browser) ?? baseLocale;
        }),
      });
    }),
  );
}
