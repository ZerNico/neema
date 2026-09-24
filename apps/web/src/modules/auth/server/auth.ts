import { Effect } from "effect";
import { getDb } from "~/db/client.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { runtime } from "~/server/runtime.ts";
import { createAppAuth } from "./config.ts";
import { OAuthRepo } from "./oauth-repo.ts";
import { makeSignupGate } from "./signup-gate.ts";
import { SignupRepo } from "./signup-repo.ts";

export type Auth = ReturnType<typeof createAppAuth>;
export type Session = Auth["$Infer"]["Session"];

const purgeUserFiles = async (userId: string) => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const attachments = yield* AttachmentService;
      yield* attachments.purgeUserFiles(userId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("attachment purge after user delete failed", {
          userId,
          cause: String(cause),
        }),
      ),
    ),
  );
};

const signup = makeSignupGate((effect) => runtime.runPromise(effect));

const onDesktopRedeemed = (userId: string, ticketId: string) =>
  runtime.runPromise(
    Effect.flatMap(SyncBus, (bus) =>
      bus.publish(userId, { type: "desktop.session.created", ticketId }),
    ),
  );

const build = async (): Promise<Auth> =>
  createAppAuth({
    // The Better Auth pool is memoized, so a rebuild costs one provider query
    // and a new options object, not a reconnect.
    db: getDb(),
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    purgeUserFiles,
    signup,
    onDesktopRedeemed,
    oauthProviders: await runtime.runPromise(
      Effect.flatMap(OAuthRepo, (repo) => repo.listForAuth()),
    ),
  });

/**
 * Better Auth resolves its context once per instance, so social provider
 * configuration read from the database is read once too. The instance is
 * therefore cached behind a version counter an admin write bumps, rather than
 * being a module constant. Sessions live in the database, so a request already
 * running against the previous instance is unaffected by the swap.
 */
let version = 0;
let cached: { version: number; auth: Promise<Auth> } | null = null;

export function currentAuth(): Promise<Auth> {
  if (cached?.version === version) return cached.auth;
  const entry = { version, auth: build() };
  cached = entry;
  // A failed build must not be cached, or one transient database error would
  // leave the process unable to authenticate anybody until it restarts.
  entry.auth.catch(() => {
    if (cached === entry) cached = null;
  });
  return entry.auth;
}

/** Call after a successful write to the provider table. */
export function invalidateAuth(): void {
  version += 1;
}

/**
 * The session behind a request, and whether the account it names may use the
 * app yet. Callers decide what an unapproved session means for them: a server
 * function refuses it distinctly so the client can show the waiting screen,
 * while an API route has nowhere to say that and simply declines.
 */
export async function sessionFromHeaders(headers: Headers) {
  const session = await (await currentAuth()).api.getSession({ headers });
  if (!session) return null;
  const status = await runtime.runPromise(
    Effect.flatMap(SignupRepo, (repo) => repo.statusOf(session.user.id)),
  );
  return { session, approved: status === "approved" };
}
