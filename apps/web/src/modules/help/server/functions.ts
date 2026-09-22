import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { userSeenFeatures } from "~/db/schema/index.ts";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { Db } from "~/server/db.ts";
import { runtime } from "~/server/runtime.ts";
import { FEATURE_KEYS } from "../features.ts";

// Only keys the app knows, so a client can't fill the table with arbitrary rows.
const MarkSeenInput = Schema.Struct({
  keys: Schema.Array(Schema.Literals(FEATURE_KEYS)).check(Schema.isMaxLength(FEATURE_KEYS.length)),
});

export const listSeenFeatures = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const rows = yield* db
          .select({ key: userSeenFeatures.featureKey })
          .from(userSeenFeatures)
          .where(eq(userSeenFeatures.userId, context.session.user.id))
          .pipe(Effect.orDie);
        return rows.map((row) => row.key);
      }),
    ),
  );

export const markFeaturesSeen = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(MarkSeenInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        if (data.keys.length === 0) return;
        const db = yield* Db;
        yield* db
          .insert(userSeenFeatures)
          .values(data.keys.map((featureKey) => ({ userId: context.session.user.id, featureKey })))
          .onConflictDoNothing()
          .pipe(Effect.orDie);
      }),
    ),
  );
