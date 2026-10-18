import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Effect, Schema } from "effect";
import { runtime } from "~/server/runtime.ts";
import { DecideApprovalInput, SetSignupPolicyInput } from "../signup.ts";
import { sessionFromHeaders } from "./auth.ts";
import { requireAdmin } from "./middleware.ts";
import { SignupRepo } from "./signup-repo.ts";

const standard = Schema.toStandardSchemaV1;

/**
 * Deliberately outside `requireSession`: the one thing a waiting account is
 * allowed to ask is whether it is still waiting. Null for a signed-out caller.
 */
export const getApprovalStatus = createServerFn({ method: "GET" }).handler(async () => {
  const current = await sessionFromHeaders(getRequestHeaders());
  if (!current) return null;
  const status = await runtime.runPromise(
    Effect.flatMap(SignupRepo, (repo) => repo.statusOf(current.session.user.id)),
  );
  return status ?? "pending";
});

/** Public: a signed-out visitor has to know whether to set up or sign in. */
export const getNeedsSetup = createServerFn({ method: "GET" }).handler(() =>
  runtime.runPromise(Effect.flatMap(SignupRepo, (repo) => repo.needsSetup())),
);

export const getSignupPolicy = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(Effect.flatMap(SignupRepo, (repo) => repo.policy())));

export const setSignupPolicy = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SetSignupPolicyInput))
  .handler(({ data }) =>
    runtime.runPromise(Effect.flatMap(SignupRepo, (repo) => repo.setPolicy(data.policy))),
  );

export const listPendingAccounts = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(Effect.flatMap(SignupRepo, (repo) => repo.listPending())));

/**
 * A rejected account is kept rather than deleted: deleting it would let the
 * same person sign up again and reappear in the queue, which is the one thing
 * rejecting them was meant to stop.
 */
export const decideAccount = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(DecideApprovalInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.flatMap(SignupRepo, (repo) =>
        repo.decide({
          userId: data.userId,
          status: data.status,
          decidedBy: context.session.user.id,
        }),
      ).pipe(
        Effect.flatMap((decided) =>
          decided
            ? Effect.void
            : Effect.die(
                new Response("You can’t decide on your own account or the owner’s", {
                  status: 409,
                }),
              ),
        ),
      ),
    ),
  );
