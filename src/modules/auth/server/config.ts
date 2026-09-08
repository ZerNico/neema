import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { count } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import type { Db } from "~/db/client.ts";
import * as schema from "~/db/schema/index.ts";

export interface ImpersonationEvent {
  action: "impersonation.start" | "impersonation.stop";
  actorId: string;
  targetId: string;
  timestamp: string;
}

type Operation = Omit<ImpersonationEvent, "timestamp">;
const startPath = "/admin/impersonate-user";
const stopPath = "/admin/stop-impersonating";

// Also used by isolated handler tests: no production runtime or environment DB is imported.
export function createAppAuth({
  db,
  baseURL,
  secret,
  purgeUserFiles,
  log = (event) => Effect.runPromise(Effect.logInfo("auth impersonation", event)),
}: {
  db: Db;
  baseURL: string | undefined;
  secret: string | undefined;
  purgeUserFiles: (userId: string) => Promise<void>;
  log?: (event: ImpersonationEvent) => Promise<void>;
}) {
  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    advanced: { database: { generateId: () => uuidv7() } },
    databaseHooks: {
      user: {
        create: {
          before: async (userData) => {
            const [row] = await db.select({ n: count() }).from(schema.user);
            return { data: { ...userData, role: (row?.n ?? 0) === 0 ? "admin" : "user" } };
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
    plugins: [admin({ impersonationSessionDuration: 60 * 60 }), tanstackStartCookies()],
  });
}
