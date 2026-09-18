import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, genericOAuth } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { count } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import type { Db } from "~/db/client.ts";
import * as schema from "~/db/schema/index.ts";
import { desktopSessions } from "./desktop-sessions.ts";

export interface ImpersonationEvent {
  action: "impersonation.start" | "impersonation.stop";
  actorId: string;
  targetId: string;
  timestamp: string;
}

/**
 * One configured sign-in provider, already decrypted. Built-ins are registered
 * under Better Auth's own key; an OIDC entry goes through the generic-oauth
 * plugin, which registers it as an ordinary social provider under the id
 * chosen here, so both kinds sign in through `signIn.social`.
 */
export type AuthOAuthProvider =
  | {
      kind: "builtin";
      id: string;
      clientId: string;
      clientSecret: string;
      tenantId?: string | undefined;
      issuer?: string | undefined;
    }
  | {
      kind: "oidc";
      id: string;
      label: string;
      clientId: string;
      clientSecret: string;
      discoveryUrl: string;
      scopes: readonly string[];
    };

type SocialProviders = NonNullable<Parameters<typeof betterAuth>[0]["socialProviders"]>;

// Each built-in is named rather than keyed dynamically, because Better Auth
// types every provider's options separately: `microsoft` takes a tenant and
// `gitlab` an issuer, while the rest take credentials alone. An id with no
// case here is a row whose provider left the catalogue, and is skipped.
function socialProvidersFrom(providers: readonly AuthOAuthProvider[]): SocialProviders {
  const social: SocialProviders = {};
  for (const p of providers) {
    if (p.kind !== "builtin") continue;
    const base = { clientId: p.clientId, clientSecret: p.clientSecret };
    switch (p.id) {
      case "google":
        social.google = base;
        break;
      case "github":
        social.github = base;
        break;
      case "discord":
        social.discord = base;
        break;
      case "apple":
        social.apple = base;
        break;
      case "microsoft":
        social.microsoft = { ...base, ...(p.tenantId ? { tenantId: p.tenantId } : {}) };
        break;
      case "gitlab":
        social.gitlab = { ...base, ...(p.issuer ? { issuer: p.issuer } : {}) };
        break;
    }
  }
  return social;
}

/**
 * How a new account is treated, decided by the caller because the policy and
 * the provider's trust live in the database and this factory deliberately
 * reaches no further than the arguments it is given.
 */
export interface SignupGate {
  /** False refuses creation outright, before any row is written. */
  allow: () => Promise<boolean>;
  /** Records whether the new account may be used yet. */
  record: (input: {
    userId: string;
    providerId: string | null;
    isFirstUser: boolean;
  }) => Promise<void>;
  /** Whether an existing account may use the app; a missing record counts as yes. */
  approved: (userId: string) => Promise<boolean>;
}

const openSignup: SignupGate = {
  allow: async () => true,
  record: async () => {},
  approved: async () => true,
};

/**
 * The provider an account is being created through, or null for email and
 * password. Better Auth routes every OAuth return through `callback/:id`, so
 * the route parameter is the provider id for built-in and generic entries
 * alike; no other user-creating endpoint carries one.
 */
const providerFromContext = (context: { path?: string; params?: unknown } | null) => {
  if (!context?.path?.startsWith("/callback")) return null;
  const params = context.params;
  if (typeof params !== "object" || params === null) return null;
  const id = (params as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
};

type Operation = Omit<ImpersonationEvent, "timestamp">;
const startPath = "/admin/impersonate-user";
const stopPath = "/admin/stop-impersonating";

/** Also used by isolated handler tests: no production runtime or environment DB is imported. */
export function createAppAuth({
  db,
  baseURL,
  secret,
  purgeUserFiles,
  oauthProviders = [],
  signup = openSignup,
  onDesktopRedeemed = async () => {},
  // Better Auth's own default; named so a test can turn the limiter on.
  rateLimit = process.env.NODE_ENV === "production",
  log = (event) => Effect.runPromise(Effect.logInfo("auth impersonation", event)),
}: {
  db: Db;
  baseURL: string | undefined;
  secret: string | undefined;
  purgeUserFiles: (userId: string) => Promise<void>;
  oauthProviders?: readonly AuthOAuthProvider[];
  signup?: SignupGate;
  /** Announces a redeemed desktop ticket to the user's open tabs. */
  onDesktopRedeemed?: (userId: string, ticketId: string) => Promise<void>;
  rateLimit?: boolean;
  log?: (event: ImpersonationEvent) => Promise<void>;
}) {
  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    socialProviders: socialProvidersFrom(oauthProviders),
    advanced: { database: { generateId: () => uuidv7() } },
    rateLimit: { enabled: rateLimit },
    databaseHooks: {
      user: {
        create: {
          before: async (userData) => {
            const [row] = await db.select({ n: count() }).from(schema.user);
            const isFirstUser = (row?.n ?? 0) === 0;
            // The account that becomes admin is how a fresh instance is set
            // up, so it is never refused; there is nobody to ask yet.
            if (!isFirstUser && !(await signup.allow())) {
              throw new APIError("FORBIDDEN", {
                message: "This instance is not accepting new accounts.",
              });
            }
            return { data: { ...userData, role: isFirstUser ? "admin" : "user" } };
          },
          after: async (created, context) => {
            await signup.record({
              userId: created.id,
              providerId: providerFromContext(context),
              // Recounting here would find the row just written, so the role
              // the before hook assigned is what identifies the first user.
              isFirstUser: created.role === "admin",
            });
          },
        },
        delete: { after: (deleted) => purgeUserFiles(deleted.id) },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== startPath && ctx.path !== stopPath) return;
        const session = await getSessionFromCtx(ctx);
        if (!session) return; // Native endpoint owns unauthenticated errors.
        const impersonatedBy = (
          session.session as typeof session.session & { impersonatedBy?: string }
        ).impersonatedBy;
        if (ctx.path === startPath && impersonatedBy) {
          throw new APIError("FORBIDDEN", {
            message: "Stop impersonating before starting another session.",
          });
        }
        const operation: Operation =
          ctx.path === startPath
            ? {
                action: "impersonation.start",
                actorId: session.user.id,
                targetId: String(ctx.body?.userId),
              }
            : {
                action: "impersonation.stop",
                actorId: impersonatedBy ?? "",
                targetId: session.user.id,
              };
        return { context: { context: { impersonationOperation: operation } } };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== startPath && ctx.path !== stopPath) return;
        const operation = (
          ctx.context as typeof ctx.context & { impersonationOperation?: Operation }
        ).impersonationOperation;
        const next = ctx.context.newSession;
        // After hooks run on API errors too. A cookie write alone is not success.
        if (!operation || isAPIError(ctx.context.returned) || !ctx.context.returned || !next)
          return;
        const impersonatedBy = (next.session as typeof next.session & { impersonatedBy?: string })
          .impersonatedBy;
        const valid =
          operation.action === "impersonation.start"
            ? next.user.id === operation.targetId && impersonatedBy === operation.actorId
            : next.user.id === operation.actorId && !impersonatedBy;
        if (!valid) return;
        try {
          await log({ ...operation, timestamp: new Date().toISOString() });
        } catch {
          // Operational logging must not make an already-completed cookie switch fail.
        }
      }),
    },
    plugins: [
      admin({ impersonationSessionDuration: 60 * 60 }),
      genericOAuth({
        config: oauthProviders
          .filter((p) => p.kind === "oidc")
          .map((p) => ({
            providerId: p.id,
            name: p.label,
            clientId: p.clientId,
            clientSecret: p.clientSecret,
            discoveryUrl: p.discoveryUrl,
            scopes: [...p.scopes],
          })),
      }),
      desktopSessions({ approved: signup.approved, onRedeemed: onDesktopRedeemed }),
      tanstackStartCookies(),
    ],
  });
}
