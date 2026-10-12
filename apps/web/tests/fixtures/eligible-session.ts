import { Effect } from "effect";
import { session, userApprovals } from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";

/** Test users have a real originating session, with the same ID for easy feed calls. */
export const seedEligibleSession = Effect.fn("fixture.seedEligibleSession")(function* (
  userId: string,
) {
  const db = yield* Db;
  yield* db.insert(userApprovals).values({ userId, status: "approved" });
  yield* db.insert(session).values({
    id: userId,
    userId,
    token: `synthetic-${userId}`,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
});
