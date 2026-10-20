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
import { emailDomain, type ApprovalStatus, type AuthSettings } from "../signup.ts";
import { lockAccount, reconcileApproval } from "./account-eligibility.ts";

export interface PendingAccount {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly requestedAt: Date;
}

export class SignupRepo extends Context.Service<
  SignupRepo,
  {
    /**
     * Read fresh on every account creation and password sign-in, like the
     * provider credentials the gateway re-reads: an admin changing them is
     * meant to take effect on the next request, not the next restart.
     */
    settings(): Effect.Effect<AuthSettings>;
    saveSettings(settings: AuthSettings): Effect.Effect<void>;
    /**
     * After an address is proven: a listed domain lets a waiting account in.
     * Only an undecided row moves, so a rejection stands.
     */
    admitVerified(account: { id: string; email: string }): Effect.Effect<void>;
    /** An admin vouching for an address, which then counts as proven. */
    markVerified(userId: string): Effect.Effect<void>;
    /**
     * True until the first account claims the instance. Read from the claim, not
     * a user count: a claim whose user insert failed must not reopen setup.
     */
    needsSetup(): Effect.Effect<boolean>;
    /** Reconciles a missing row before returning the user's status. */
    statusOf(userId: string): Effect.Effect<ApprovalStatus | null>;
    record(input: { userId: string; status: ApprovalStatus }): Effect.Effect<void>;
    listPending(): Effect.Effect<PendingAccount[]>;
    /**
     * False when refused: nobody decides on their own account, and the
     * bootstrap owner cannot be rejected, since either could leave no admin.
     */
    decide(input: {
      userId: string;
      status: "approved" | "rejected";
      decidedBy: string;
    }): Effect.Effect<boolean>;
  }
>()("chat/auth/SignupRepo") {
  static readonly layer = Layer.effect(
    SignupRepo,
    Effect.gen(function* () {
      const db = yield* Db;

      const self: SignupRepo["Service"] = SignupRepo.of({
        settings: Effect.fn("SignupRepo.settings")(function* () {
          const [row] = yield* db
            .select()
            .from(authSettings)
            .where(eq(authSettings.id, AUTH_SETTINGS_ID))
            .pipe(Effect.orDie);
          // A missing row is a database older than the seeding migration, and
          // refusing everyone would be a worse answer than its old behaviour.
          return {
            passwordSignup: row?.passwordSignup ?? "open",
            passwordLogin: row?.passwordLogin ?? true,
            requireEmailVerification: row?.requireEmailVerification ?? false,
            admitDomains: row?.admitDomains ?? [],
          };
        }),

        saveSettings: Effect.fn("SignupRepo.saveSettings")(function* (settings) {
          const values = {
            passwordSignup: settings.passwordSignup,
            passwordLogin: settings.passwordLogin,
            requireEmailVerification: settings.requireEmailVerification,
            admitDomains: [...new Set(settings.admitDomains)],
          };
          yield* db
            .insert(authSettings)
            .values({ id: AUTH_SETTINGS_ID, ...values })
            .onConflictDoUpdate({
              target: authSettings.id,
              set: { ...values, updatedAt: new Date() },
            })
            .pipe(Effect.orDie);
        }),

        admitVerified: Effect.fn("SignupRepo.admitVerified")(function* ({ id, email }) {
          const domain = emailDomain(email);
          const { admitDomains } = yield* self.settings();
          if (domain && admitDomains.includes(domain))
            yield* self.record({ userId: id, status: "approved" });
        }),

        markVerified: Effect.fn("SignupRepo.markVerified")(function* (userId) {
          const [updated] = yield* db
            .update(user)
            .set({ emailVerified: true, updatedAt: new Date() })
            .where(eq(user.id, userId))
            .returning({ id: user.id, email: user.email })
            .pipe(Effect.orDie);
          if (updated) yield* self.admitVerified(updated);
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
          yield* reconcileApproval(db, userId);
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
                if (!(yield* lockAccount(tx, userId)).length) return;
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
              emailVerified: user.emailVerified,
              requestedAt: userApprovals.requestedAt,
            })
            .from(userApprovals)
            .innerJoin(user, eq(user.id, userApprovals.userId))
            .where(eq(userApprovals.status, "pending"))
            .orderBy(desc(userApprovals.requestedAt))
            .pipe(Effect.orDie);
        }),

        decide: Effect.fn("SignupRepo.decide")(function* ({ userId, status, decidedBy }) {
          if (userId === decidedBy) return false;
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (!(yield* lockAccount(tx, userId)).length) return true;
                if (status === "rejected") {
                  const [claim] = yield* tx
                    .select({ ownerId: signupBootstrap.ownerId })
                    .from(signupBootstrap)
                    .where(eq(signupBootstrap.id, AUTH_SETTINGS_ID));
                  if (claim?.ownerId === userId) return false;
                }
                yield* reconcileApproval(tx, userId);
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
                return true;
              }),
            )
            .pipe(Effect.orDie);
        }),
      });
      return self;
    }),
  );
}
