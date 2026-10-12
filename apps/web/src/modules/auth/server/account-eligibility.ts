import { and, eq, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { AUTH_SETTINGS_ID, session, user, userApprovals } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";

type DbClient = Db["Service"] | DbTx;

export class AccountIneligible extends Schema.TaggedError<AccountIneligible>()(
  "AccountIneligible",
  {
    userId: Schema.String,
    reason: Schema.Literals(["missing", "unapproved", "banned"]),
  },
) {}

export const lockAccount = (tx: DbTx, userId: string) =>
  tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .for("no key update")
    .pipe(Effect.orDie);

export const reconcileApproval = (tx: DbClient, userId: string) =>
  tx
    .execute(sql`
    INSERT INTO user_approvals (user_id, status, decided_at)
    SELECT u.id,
      CASE WHEN b.owner_id = u.id THEN 'approved' ELSE 'pending' END,
      CASE WHEN b.owner_id = u.id THEN now() ELSE NULL END
    FROM "user" u LEFT JOIN signup_bootstrap b ON b.id = ${AUTH_SETTINGS_ID}
    WHERE u.id = ${userId}
    ON CONFLICT (user_id) DO NOTHING
  `)
    .pipe(Effect.orDie);

/** Hold the user's row through acceptance. Approval writers take the same lock,
 * and native ban, update and delete already lock it. No session or role bypass. */
export const requireEligibleAccount = Effect.fn("auth.requireEligibleAccount")(function* (
  tx: DbTx,
  userId: string,
) {
  if (!(yield* lockAccount(tx, userId)).length)
    return yield* new AccountIneligible({ userId, reason: "missing" });
  yield* reconcileApproval(tx, userId);
  const [row] = yield* tx
    .select({
      status: userApprovals.status,
      activeBan: sql<boolean>`${user.banned} and (${user.banExpires} is null or ${user.banExpires} > clock_timestamp())`,
    })
    .from(user)
    .innerJoin(userApprovals, eq(userApprovals.userId, user.id))
    .where(eq(user.id, userId))
    .pipe(Effect.orDie);
  if (row?.status !== "approved")
    return yield* new AccountIneligible({ userId, reason: "unapproved" });
  if (row.activeBan) return yield* new AccountIneligible({ userId, reason: "banned" });
});

/** A short preflight, not a substitute for the check in the acceptance transaction. */
export const accountEligible = Effect.fn("auth.accountEligible")(function* (userId: string) {
  const db = yield* Db;
  return yield* db
    .transaction((tx) => requireEligibleAccount(tx, userId).pipe(Effect.as(true)))
    .pipe(
      Effect.catchTag("AccountIneligible", () => Effect.succeed(false)),
      Effect.orDie,
    );
});

/** Another session for this person cannot keep a revoked device's feed alive. */
export const originatingSessionEligible = Effect.fn("auth.originatingSessionEligible")(function* (
  db: DbTx,
  sessionId: string,
  userId: string,
) {
  const eligible = yield* requireEligibleAccount(db, userId).pipe(
    Effect.as(true),
    Effect.catchTag("AccountIneligible", () => Effect.succeed(false)),
  );
  if (!eligible) return false;
  const [found] = yield* db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.id, sessionId),
        eq(session.userId, userId),
        sql`${session.expiresAt} > clock_timestamp()`,
      ),
    )
    .pipe(Effect.orDie);
  return Boolean(found);
});
