import { notifyOnCommit } from "~/modules/sync/server/signals.ts";
import { desc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { AUTH_SETTINGS_ID, authSettings, user, userApprovals } from "~/db/schema/index.ts";
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
    /** Null for a user with no row, which is a user created before this existed. */
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

        statusOf: Effect.fn("SignupRepo.statusOf")(function* (userId) {
          const rows = yield* db
            .select({ status: userApprovals.status })
            .from(userApprovals)
            .where(eq(userApprovals.userId, userId))
            .pipe(Effect.orDie);
          return rows[0]?.status ?? null;
        }),

        record: Effect.fn("SignupRepo.record")(function* ({ userId, status }) {
          yield* db
            .insert(userApprovals)
            .values({
              userId,
              status,
              ...(status === "approved" ? { decidedAt: new Date() } : {}),
            })
            // Creation writes this row once. Doing nothing on conflict keeps a
            // retried signup from resetting a decision an admin already made.
            .onConflictDoNothing({ target: userApprovals.userId })
            .pipe(Effect.orDie);
        }),

        listPending: Effect.fn("SignupRepo.listPending")(function* () {
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
