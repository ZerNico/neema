import { notifyOnCommit } from "~/modules/sync/server/signals.ts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  AUTH_SETTINGS_ID,
  authSettings,
  signupBootstrap,
  user,
  userApprovals,
} from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";
import type { ApprovalStatus, SignupPolicy } from "../signup.ts";

export interface PendingAccount {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly requestedAt: Date;
}

export class SignupRepo extends Context.Service<
  SignupRepo,
  {
    /**
     * Read fresh on every account creation and every session check, like the
     * provider credentials the gateway re-reads: an admin changing the policy
     * is meant to take effect on the next request, not the next restart.
     */
    policy(): Effect.Effect<SignupPolicy>;
    setPolicy(policy: SignupPolicy): Effect.Effect<void>;
    /**
     * True until the first account claims the instance. Read from the claim, not
     * a user count: a claim whose user insert failed must not reopen setup.
     */
    needsSetup(): Effect.Effect<boolean>;
    /** Reconciles a missing row before returning the user's status. */
    statusOf(userId: string): Effect.Effect<ApprovalStatus | null>;
    record(input: { userId: string; status: ApprovalStatus }): Effect.Effect<void>;
    listPending(): Effect.Effect<PendingAccount[]>;
    decide(input: {
      userId: string;
      status: "approved" | "rejected";
      decidedBy: string;
    }): Effect.Effect<void>;
  }
>()("chat/auth/SignupRepo") {
  static readonly layer = Layer.effect(
    SignupRepo,
    Effect.gen(function* () {
      const db = yield* Db;

      return SignupRepo.of({
        policy: Effect.fn("SignupRepo.policy")(function* () {
          const rows = yield* db
            .select()
            .from(authSettings)
            .where(eq(authSettings.id, AUTH_SETTINGS_ID))
            .pipe(Effect.orDie);
          // A missing row is a database older than the seeding migration, and
          // refusing everyone would be a worse answer than today's behaviour.
          return rows[0]?.signupPolicy ?? "open";
        }),

        setPolicy: Effect.fn("SignupRepo.setPolicy")(function* (policy) {
          yield* db
            .insert(authSettings)
            .values({ id: AUTH_SETTINGS_ID, signupPolicy: policy })
            .onConflictDoUpdate({
              target: authSettings.id,
              set: { signupPolicy: policy, updatedAt: new Date() },
            })
            .pipe(Effect.orDie);
        }),

        needsSetup: Effect.fn("SignupRepo.needsSetup")(function* () {
          const rows = yield* db
            .select({ id: signupBootstrap.id })
            .from(signupBootstrap)
            .where(eq(signupBootstrap.id, AUTH_SETTINGS_ID))
            .pipe(Effect.orDie);
          return rows.length === 0;
        }),

        statusOf: Effect.fn("SignupRepo.statusOf")(function* (userId) {
          // The bootstrap claim is the sole authority for recovering a lost
          // after-hook. Everyone else without a row enters the admin queue.
          yield* db
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
          const rows = yield* db
            .select({ status: userApprovals.status })
            .from(userApprovals)
            .where(eq(userApprovals.userId, userId))
            .pipe(Effect.orDie);
          return rows[0]?.status ?? null;
        }),

        record: Effect.fn("SignupRepo.record")(function* ({ userId, status }) {
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const inserted = yield* tx
                  .insert(userApprovals)
                  .values({
                    userId,
                    status,
                    ...(status === "approved" ? { decidedAt: new Date() } : {}),
                  })
                  .onConflictDoNothing({ target: userApprovals.userId })
                  .returning({ userId: userApprovals.userId });
                if (inserted.length || status !== "approved") return;

                // A status read may have reconciled a missing row while the
                // signup after-hook was still pending. Only that undecided row
                // may be promoted; an admin decision wins the row lock.
                const promoted = yield* tx
                  .update(userApprovals)
                  .set({ status: "approved", decidedAt: new Date() })
                  .where(
                    and(
                      eq(userApprovals.userId, userId),
                      eq(userApprovals.status, "pending"),
                      isNull(userApprovals.decidedAt),
                      isNull(userApprovals.decidedBy),
                    ),
                  )
                  .returning({ userId: userApprovals.userId });
                if (promoted.length)
                  yield* notifyOnCommit(tx, {
                    scope: "user",
                    userId,
                    event: { type: "account.approval.changed" },
                  });
              }),
            )
            .pipe(Effect.orDie);
        }),

        listPending: Effect.fn("SignupRepo.listPending")(function* () {
          yield* db
            .execute(sql`
            INSERT INTO user_approvals (user_id, status)
            SELECT u.id, 'pending' FROM "user" u
            LEFT JOIN user_approvals a ON a.user_id = u.id
            LEFT JOIN signup_bootstrap b ON b.id = ${AUTH_SETTINGS_ID}
            WHERE a.user_id IS NULL AND (b.owner_id IS NULL OR b.owner_id <> u.id)
            ON CONFLICT (user_id) DO NOTHING
          `)
            .pipe(Effect.orDie);
          return yield* db
            .select({
              userId: userApprovals.userId,
              name: user.name,
              email: user.email,
              requestedAt: userApprovals.requestedAt,
            })
            .from(userApprovals)
            .innerJoin(user, eq(user.id, userApprovals.userId))
            .where(eq(userApprovals.status, "pending"))
            .orderBy(desc(userApprovals.requestedAt))
            .pipe(Effect.orDie);
        }),

        decide: Effect.fn("SignupRepo.decide")(function* ({ userId, status, decidedBy }) {
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const changed = yield* tx
                  .update(userApprovals)
                  .set({ status, decidedAt: new Date(), decidedBy })
                  .where(eq(userApprovals.userId, userId))
                  .returning({ userId: userApprovals.userId });
                if (changed.length)
                  yield* notifyOnCommit(tx, {
                    scope: "user",
                    userId,
                    event: { type: "account.approval.changed" },
                  });
              }),
            )
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
