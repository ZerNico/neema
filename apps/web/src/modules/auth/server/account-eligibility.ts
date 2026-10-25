import { and, eq, sql } from "drizzle-orm";
import { Duration, Effect, Schema } from "effect";
import { AUTH_SETTINGS_ID, authSettings, session, user, userApprovals } from "~/db/schema/index.ts";
import { Db, type DbTx } from "~/server/db.ts";
import { verificationRequired } from "./password-login.ts";

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
 * and native ban, update and delete already lock it. No session or role bypass.
 * Returns whether the account holds the admin role, read with the rest. */
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
      role: user.role,
    })
    .from(user)
    .innerJoin(userApprovals, eq(userApprovals.userId, user.id))
    .where(eq(user.id, userId))
    .pipe(Effect.orDie);
  if (row?.status !== "approved")
    return yield* new AccountIneligible({ userId, reason: "unapproved" });
  if (row.activeBan) return yield* new AccountIneligible({ userId, reason: "banned" });
  return { admin: row.role === "admin" };
});

/**
 * SQL over an alias of `user`: the account may act now, so others may find it
 * and share with it, and its shared work stays live. Approved or the bootstrap
 * owner, and not banned; a sign-up still waiting or turned down is nobody's
 * recipient.
 */
export const activeAccountOf = (alias: string) => {
  const column = (name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  const id = column("id");
  return sql<boolean>`(
  (exists (select 1 from user_approvals a where a.user_id = ${id} and a.status = 'approved')
    or (exists (select 1 from signup_bootstrap b
          where b.id = ${AUTH_SETTINGS_ID} and b.owner_id = ${id})
        and not exists (select 1 from user_approvals a where a.user_id = ${id})))
  and not (${column("banned")} and (${column("ban_expires")} is null or ${column("ban_expires")} > clock_timestamp()))
)`;
};

export const activeAccountSql = activeAccountOf("user");

/**
 * An active account someone may find by typing its address. While addresses
 * must be proven, an unproven one is whatever its owner typed, and finding it
 * would hand them whatever was meant for the real person.
 */
export const addressableByEmailSql = (required: boolean) =>
  required ? sql<boolean>`(${activeAccountSql} and ${user.emailVerified})` : activeAccountSql;

/** `verificationRequired` as stored now, read through the caller's client or transaction. */
export const verificationRequiredIn = (db: DbClient) =>
  db
    .select({ stored: authSettings.requireEmailVerification })
    .from(authSettings)
    .where(eq(authSettings.id, AUTH_SETTINGS_ID))
    .pipe(
      Effect.orDie,
      Effect.map(([row]) =>
        verificationRequired({ requireEmailVerification: row?.stored ?? false }),
      ),
    );

/**
 * A short preflight, not a substitute for the check in the acceptance
 * transaction. It runs on every request, so it is one plain read: no lock that
 * one person's parallel requests would queue on. Only an account with no
 * approval row takes the locked path, which repairs that row.
 */
export const accountEligible = Effect.fn("auth.accountEligible")(function* (userId: string) {
  const db = yield* Db;
  const [row] = yield* db
    .select({
      active: activeAccountSql,
      recorded: sql<boolean>`exists (select 1 from user_approvals a where a.user_id = ${user.id})`,
    })
    .from(user)
    .where(eq(user.id, userId))
    .pipe(Effect.orDie);
  if (!row) return false;
  if (row.recorded) return row.active;
  return yield* db
    .transaction((tx) => requireEligibleAccount(tx, userId).pipe(Effect.as(true)))
    .pipe(
      Effect.catchTag("AccountIneligible", () => Effect.succeed(false)),
      Effect.orDie,
    );
});

/** The session still exists for this person and has not expired, by the database clock. */
const sessionLive = (db: DbClient, sessionId: string, userId: string) =>
  db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.id, sessionId),
        eq(session.userId, userId),
        sql`${session.expiresAt} > clock_timestamp()`,
      ),
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length > 0),
    );

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
  return yield* sessionLive(db, sessionId, userId);
});

const SESSION_RECHECK = Duration.seconds(30);

/**
 * Completes once a long-lived feed's session, or its account, no longer holds.
 * A feed checks at connect only; sign-out, revocation and bans end it here.
 * It reads without locking, as the per-request check does.
 */
export const sessionEnded = Effect.fn("auth.sessionEnded")(function* (
  sessionId: string,
  userId: string,
) {
  const db = yield* Db;
  const holds = Effect.gen(function* () {
    if (!(yield* accountEligible(userId).pipe(Effect.provideService(Db, db)))) return false;
    return yield* sessionLive(db, sessionId, userId);
  });
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(SESSION_RECHECK);
      if (!(yield* holds)) return;
    }
  });
});
