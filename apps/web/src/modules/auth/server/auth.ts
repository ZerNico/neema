import { Effect } from "effect";
import { getDb } from "~/db/client.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { MailService } from "~/modules/notifications/server/mail.ts";
import { mcpResourceFor } from "~/modules/mcp-server/resource.ts";
import { fetchClientMetadata } from "~/modules/mcp-server/server/client-metadata-fetch.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { publicUrl } from "~/server/public-url.ts";
import { runtime } from "~/server/runtime.ts";
import { createAppAuth, passwordLoginForced, type AuthMail } from "./config.ts";
import { OAuthRepo } from "./oauth-repo.ts";
import { makeSignupGate } from "./signup-gate.ts";
import { SignupRepo } from "./signup-repo.ts";
import { accountEligible } from "./account-eligibility.ts";

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

/** Whether this account may connect an app now: the same check every MCP request makes. */
export const mayConnectApps = (userId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      if (!(yield* accountEligible(userId))) return false;
      return yield* Effect.flatMap(FeaturePolicy, (policy) => policy.can(userId, "mcp"));
    }),
  );

/** Tokens are bound to the public address, so there is no MCP server without a secure one. */
export const mcpResource = () => mcpResourceFor(publicUrl());

const mcpAuthorization = () => {
  const resource = mcpResource();
  return resource ? { resource, allowed: mayConnectApps, fetchClientMetadata } : undefined;
};

/**
 * The nearest proxy names the client it saw and never itself, so the default
 * trusts no hop. `TRUSTED_PROXIES` lists only proxies in front of that one,
 * such as a CDN, whose entries Better Auth then skips from the right.
 */
const clientIpSettings = () => {
  const header = (process.env.CLIENT_IP_HEADER?.trim() || "x-forwarded-for").toLowerCase();
  // An invalid name would make every session creation throw in `Headers.get`.
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header))
    throw new Error(`CLIENT_IP_HEADER is not a header name: ${header}`);
  return {
    trustedProxies: (process.env.TRUSTED_PROXIES ?? "")
      .split(",")
      .map((proxy) => proxy.trim())
      .filter(Boolean),
    header,
  };
};

// A failed send is logged, not thrown: the reset endpoint must answer the same
// for every address, and a stuck verification is retried by signing in again.
const sendAuthMail = (to: string, subject: string, text: string) =>
  runtime.runPromise(
    Effect.flatMap(MailService, (mail) => mail.sendTo(to, subject, text)).pipe(
      Effect.catch((error) =>
        Effect.logWarning("auth email could not be sent", { reason: error.reason }),
      ),
    ),
  );

const authMail = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      if (!(yield* Effect.flatMap(MailService, (mail) => mail.available))) return undefined;
      const settings = yield* Effect.flatMap(SignupRepo, (repo) => repo.settings());
      return {
        // The operator's way back in also lifts verification: a broken mail
        // server would otherwise keep every password account out.
        requireVerification: settings.requireEmailVerification && !passwordLoginForced(),
        send: sendAuthMail,
      } satisfies AuthMail;
    }),
  );

const build = async (): Promise<Auth> =>
  createAppAuth({
    // The Better Auth pool is memoized, so a rebuild costs one provider query
    // and a new options object, not a reconnect.
    db: getDb(),
    baseURL: publicUrl(),
    secret: process.env.AUTH_SECRET,
    purgeUserFiles,
    signup,
    mail: await authMail(),
    onDesktopRedeemed,
    mcp: mcpAuthorization(),
    clientIp: clientIpSettings(),
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

/** Call after a successful write to providers, mail, or verification. */
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
  const approved = await runtime.runPromise(accountEligible(session.user.id));
  return { session, approved };
}
