import { betterAuth } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, genericOAuth } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { mcp as mcpProvider } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { and, count, eq, ne } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import type { Db } from "~/db/client.ts";
import * as schema from "~/db/schema/index.ts";
import { MCP_SCOPES, OFFLINE_ACCESS } from "~/modules/mcp-server/scopes.ts";
import { SIGN_IN_WITH_PROVIDER, SIGNUP_CLOSED } from "../oauth-errors.ts";
import { desktopSessions } from "./desktop-sessions.ts";
import { mcpAccess } from "./mcp-access.ts";
import { passwordLoginForced } from "./password-login.ts";
import {
  resetPasswordMail,
  verifyEmailMail,
  type MailContent,
} from "~/modules/notifications/server/email/templates.tsx";

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
      trustEmails: boolean;
      clientId: string;
      clientSecret: string;
      tenantId?: string | undefined;
      issuer?: string | undefined;
    }
  | {
      kind: "oidc";
      id: string;
      trustEmails: boolean;
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
 * How a new account is treated, decided by the caller because the settings
 * and each provider's mode live in the database and this factory deliberately
 * reaches no further than the arguments it is given.
 */
export interface SignupGate {
  /**
   * Before any row is written. False refuses creation; `emailVerified` is what
   * the new row records, which a provider whose emails are trusted raises.
   */
  admit: (input: {
    providerId: string | null;
    email: string;
    emailVerified: boolean;
  }) => Promise<{ allowed: boolean; emailVerified: boolean }>;
  /** Records whether the new account may be used yet. */
  record: (input: {
    userId: string;
    providerId: string | null;
    email: string;
    emailVerified: boolean;
    isFirstUser: boolean;
  }) => Promise<void>;
  /** An address was just proven, which a listed domain turns into admission. */
  verified: (user: { id: string; email: string }) => Promise<void>;
  /** Whether password sign-in, registration and reset are offered right now. */
  passwordAllowed: () => Promise<boolean>;
  /** Whether an existing account may use the app; missing approvals are reconciled first. */
  approved: (userId: string) => Promise<boolean>;
}

const openSignup: SignupGate = {
  admit: async ({ emailVerified }) => ({ allowed: true, emailVerified }),
  record: async () => {},
  verified: async () => {},
  passwordAllowed: async () => true,
  approved: async () => true,
};

/**
 * Mail the auth instance sends. Absent without an SMTP server, which leaves
 * verification off and password reset unavailable.
 */
export interface AuthMail {
  /** Baked into the instance, so changing it rebuilds through `invalidateAuth`. */
  requireVerification: boolean;
  send: (to: string, subject: string, content: MailContent) => Promise<void>;
}

/**
 * Endpoints that create a session for someone already signed in: a desktop
 * ticket minted by a browser session, a session rotation, impersonation.
 * Every other session is a sign-in, and must come through the right way in.
 */
const SESSION_CONTINUATIONS = new Set([
  "/desktop/session",
  "/update-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
]);

/**
 * Whether a sign-in may open a session for an account bound to these exclusive
 * providers: any way in for an unbound account, only one of them otherwise.
 */
export const signsInThrough = (
  context: Parameters<typeof methodFromContext>[0],
  exclusive: readonly { id: string }[],
) => {
  if (exclusive.length === 0) return true;
  const method = methodFromContext(context);
  return typeof method === "string" && exclusive.some((p) => p.id === method);
};

const PASSWORD_PATHS = [
  "/sign-in/email",
  "/sign-up/email",
  "/request-password-reset",
  "/reset-password",
];

/**
 * The way in an account is being created through: a provider id, null for
 * email and password, or undefined for any other endpoint, which admits nobody
 * new. An OAuth return carries the provider as `callback/:id`, generic entries
 * included; an ID token signs up within `/sign-in/social` itself.
 */
export const methodFromContext = (
  context: { path?: string; params?: unknown; body?: unknown } | null,
): string | null | undefined => {
  if (context?.path === "/sign-up/email") return null;
  const source = context?.path?.startsWith("/callback/")
    ? context.params
    : context?.path === "/sign-in/social"
      ? context.body
      : undefined;
  if (typeof source !== "object" || source === null) return undefined;
  const id = (source as Record<string, unknown>).id ?? (source as Record<string, unknown>).provider;
  return typeof id === "string" ? id : undefined;
};

const refuseNewAccount = () =>
  new APIError("FORBIDDEN", {
    // The OAuth callback forwards a code to the error page.
    code: SIGNUP_CLOSED,
    message: "This instance is not accepting new accounts.",
  });

/**
 * This instance as an OAuth authorization server for its own MCP endpoint.
 * Absent without a public URL, since tokens are bound to that address.
 */
export interface McpAuthorization {
  /** The MCP endpoint's absolute URL, the audience of every token. */
  resource: string;
  allowed: (userId: string) => Promise<boolean>;
  /** Resolve-once, pinned, redirect-refusing fetch for client metadata documents. */
  fetchClientMetadata: ClientMetadataResourceFetch;
}

const MCP_GRANT_SCOPES = [...MCP_SCOPES, OFFLINE_ACCESS];

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
  mail,
  onDesktopRedeemed = async () => {},
  mcp,
  // Better Auth's own default; named so a test can turn the limiter on.
  rateLimit = process.env.NODE_ENV === "production",
  clientIp,
  log = (event) => Effect.runPromise(Effect.logInfo("auth impersonation", event)),
}: {
  db: Db;
  baseURL: string | undefined;
  secret: string | undefined;
  purgeUserFiles: (userId: string) => Promise<void>;
  oauthProviders?: readonly AuthOAuthProvider[];
  signup?: SignupGate;
  mail?: AuthMail | undefined;
  /** Announces a redeemed desktop ticket to the user's open tabs. */
  onDesktopRedeemed?: (userId: string, ticketId: string) => Promise<void>;
  mcp?: McpAuthorization | undefined;
  rateLimit?: boolean;
  /** Who a request came from, for rate limits: the proxies to see through, and the header. */
  clientIp?: { trustedProxies: readonly string[]; header: string };
  log?: (event: ImpersonationEvent) => Promise<void>;
}) {
  /** The enabled exclusive providers an account is connected to, by id and label. */
  const exclusiveSignIns = async (userId: string) => {
    if (passwordLoginForced()) return [];
    return db
      .select({ id: schema.oauthProviders.id, label: schema.oauthProviders.label })
      .from(schema.account)
      .innerJoin(
        schema.oauthProviders,
        and(
          eq(schema.oauthProviders.id, schema.account.providerId),
          eq(schema.oauthProviders.enabled, true),
          eq(schema.oauthProviders.exclusive, true),
        ),
      )
      .where(eq(schema.account.userId, userId));
  };

  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      // Without mail there is no way to prove an address, so nothing waits on one.
      requireEmailVerification: mail?.requireVerification ?? false,
      revokeSessionsOnPasswordReset: true,
      ...(mail
        ? {
            sendResetPassword: async ({ user, url }) =>
              mail.send(user.email, "Reset your password", await resetPasswordMail(url)),
          }
        : {}),
    },
    emailVerification: {
      sendOnSignUp: mail?.requireVerification ?? false,
      sendOnSignIn: mail?.requireVerification ?? false,
      autoSignInAfterVerification: true,
      ...(mail
        ? {
            sendVerificationEmail: async ({ user, url }) =>
              mail.send(user.email, "Confirm your email", await verifyEmailMail(url)),
          }
        : {}),
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // Never merge a sign-in into an account whose address nobody proved:
        // whoever typed it first would own the real person's login.
        requireLocalEmailVerified: true,
        trustedProviders: oauthProviders.filter((p) => p.trustEmails).map((p) => p.id),
        // Only reaches a link the signed-in person starts, who proves both
        // accounts; a company login rarely shares a personal address.
        allowDifferentEmails: true,
      },
    },
    socialProviders: socialProvidersFrom(oauthProviders),
    advanced: {
      database: { generateId: () => uuidv7() },
      ...(clientIp
        ? {
            ipAddress: {
              ipAddressHeaders: [clientIp.header],
              trustedProxies: [...clientIp.trustedProxies],
            },
          }
        : {}),
    },
    rateLimit: { enabled: rateLimit },
    databaseHooks: {
      // A provider marked exclusive is the only way in for accounts connected
      // to it: every session they get comes through it, or continues one that
      // did. Refused at the session rather than the request, so a password
      // sign-in only learns this once the password has checked out.
      session: {
        create: {
          before: async (created, context) => {
            if (!context?.path || SESSION_CONTINUATIONS.has(context.path)) return;
            const exclusive = await exclusiveSignIns(created.userId);
            if (signsInThrough(context, exclusive)) return;
            throw new APIError("FORBIDDEN", {
              code: SIGN_IN_WITH_PROVIDER,
              message: `This account signs in with ${exclusive[0]!.label}.`,
            });
          },
        },
      },
      // Nor may such an account gain a password: a reset would otherwise add one.
      account: {
        create: {
          before: async (created) => {
            if (created.providerId !== "credential") return;
            if ((await exclusiveSignIns(created.userId)).length > 0)
              throw new APIError("FORBIDDEN", { message: "This account has no password." });
          },
        },
      },
      user: {
        create: {
          before: async (userData, context) => {
            // Better Auth writes the user after this hook, outside our claim
            // transaction. Keep the preallocated id even if that write fails:
            // recycling it could admit a late writer as a second admin.
            const id = uuidv7();
            const [row] = await db.select({ n: count() }).from(schema.user);
            const [claimed] =
              (row?.n ?? 0) === 0
                ? await db
                    .insert(schema.signupBootstrap)
                    .values({ id: schema.AUTH_SETTINGS_ID, ownerId: id })
                    .onConflictDoNothing()
                    .returning({ ownerId: schema.signupBootstrap.ownerId })
                : [];
            const isFirstUser = claimed?.ownerId === id;
            if (isFirstUser) return { data: { ...userData, id, role: "admin" } };
            const method = methodFromContext(context);
            if (method === undefined) throw refuseNewAccount();
            const admission = await signup.admit({
              providerId: method,
              email: userData.email,
              emailVerified: userData.emailVerified,
            });
            if (!admission.allowed) throw refuseNewAccount();
            return {
              data: { ...userData, id, role: "user", emailVerified: admission.emailVerified },
            };
          },
          after: async (created, context) => {
            await signup.record({
              userId: created.id,
              providerId: methodFromContext(context) ?? null,
              email: created.email,
              emailVerified: created.emailVerified,
              // Recounting here would find the row just written, so the role
              // the before hook assigned is what identifies the first user.
              isFirstUser: created.role === "admin",
            });
          },
        },
        // Every way an address becomes verified updates the row: the emailed
        // link, a provider confirming it on a later sign-in, an admin.
        update: {
          after: async (updated) => {
            if (updated.emailVerified) await signup.verified(updated);
          },
        },
        delete: { after: (deleted) => purgeUserFiles(deleted.id) },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/unlink-account") {
          // Leaving an exclusive provider would hand the account back to a password.
          const leaving = String((ctx.body as { accountId?: unknown } | undefined)?.accountId);
          const [bound] = await db
            .select({ id: schema.account.id })
            .from(schema.account)
            .innerJoin(
              schema.oauthProviders,
              and(
                eq(schema.oauthProviders.id, schema.account.providerId),
                eq(schema.oauthProviders.enabled, true),
                eq(schema.oauthProviders.exclusive, true),
              ),
            )
            .where(eq(schema.account.id, leaving));
          if (bound)
            throw new APIError("FORBIDDEN", { message: "This sign-in can’t be disconnected." });
        }
        if (ctx.path === "/unlink-account" && !(await signup.passwordAllowed())) {
          // Without passwords, the last account on an enabled provider is the only way back in.
          const session = await getAuthoritativeSessionFromCtx(ctx);
          if (!session) return;
          // The account row's own id, which is what Better Auth unlinks by.
          const leaving = String((ctx.body as { accountId?: unknown } | undefined)?.accountId);
          const [left] = await db
            .select({ n: count() })
            .from(schema.account)
            .innerJoin(
              schema.oauthProviders,
              and(
                eq(schema.oauthProviders.id, schema.account.providerId),
                eq(schema.oauthProviders.enabled, true),
              ),
            )
            .where(and(eq(schema.account.userId, session.user.id), ne(schema.account.id, leaving)));
          if ((left?.n ?? 0) === 0)
            throw new APIError("FORBIDDEN", {
              message: "Connect another sign-in first. Passwords are turned off.",
            });
          return;
        }
        if (PASSWORD_PATHS.some((path) => ctx.path.startsWith(path))) {
          if (!(await signup.passwordAllowed()))
            throw new APIError("FORBIDDEN", { message: "Password sign-in is turned off." });
          if (ctx.path !== "/sign-up/email") return;
          // Asked here as well as at creation: with verification required,
          // Better Auth answers a refused creation as success, so the person
          // would wait for a link that never comes.
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          const admission = await signup.admit({
            providerId: null,
            email: typeof email === "string" ? email.toLowerCase() : "",
            emailVerified: false,
          });
          if (!admission.allowed) throw refuseNewAccount();
          return;
        }
        if (!ctx.path.startsWith("/admin/")) return;
        const session = await getAuthoritativeSessionFromCtx(ctx);
        if (!session) return; // Native endpoint owns unauthenticated errors.
        const impersonatedBy = (
          session.session as typeof session.session & { impersonatedBy?: string }
        ).impersonatedBy;
        // Restoration stays usable after suspension, but grants no new authority.
        if (ctx.path !== stopPath) {
          if (!(await signup.approved(impersonatedBy ?? session.user.id))) {
            throw new APIError("FORBIDDEN", {
              message: "This account cannot administer the instance.",
            });
          }
        }
        if (ctx.path !== startPath && ctx.path !== stopPath) return;
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
      ...(mcp
        ? [
            mcpProvider({
              resource: mcp.resource,
              loginPage: "/oauth/sign-in",
              consentPage: "/oauth/consent",
              // Opaque tokens, checked in-process: no JWKS to serve, no call
              // back to our own public URL, and a revoke takes effect at once.
              disableJwtPlugin: true,
              scopes: MCP_GRANT_SCOPES,
              // Every token acts for a person; client_credentials would not.
              grantTypes: ["authorization_code", "refresh_token"],
              // Everything is requested by default; consent is where it narrows.
              clientRegistrationDefaultScopes: MCP_GRANT_SCOPES,
              clientRegistrationAllowedScopes: MCP_GRANT_SCOPES,
              // MCP 2026-07-28 registers through metadata documents; older
              // clients still register dynamically.
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
              // Cursor and older Claude Code omit `application_type`; as "web"
              // their loopback redirects would be refused.
              clientRegistrationDefaultApplicationType: "infer",
              accessTokenExpiresIn: 60 * 60,
              refreshTokenExpiresIn: 30 * 24 * 60 * 60,
            }),
            cimd({
              fetchClientMetadataResource: mcp.fetchClientMetadata,
              metadataProfile: "mcp-2026-07-28",
            }),
            mcpAccess({ allowed: mcp.allowed }),
          ]
        : []),
      tanstackStartCookies(),
    ],
  });
}
