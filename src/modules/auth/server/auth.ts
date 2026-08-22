import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { count } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import { getDb } from "~/db/client.ts";
import * as schema from "~/db/schema/index.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { runtime } from "~/server/runtime.ts";

async function isFirstUser() {
  const [row] = await getDb().select({ n: count() }).from(schema.user);
  return (row?.n ?? 0) === 0;
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(getDb(), {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    database: {
      generateId: () => uuidv7(),
    },
  },
  databaseHooks: {
    user: {
      create: {
        // First registered user becomes the instance admin.
        before: async (userData) => ({
          data: { ...userData, role: (await isFirstUser()) ? "admin" : "user" },
        }),
      },
      delete: {
        // Attachment rows cascade off the user FK; the stored bytes do not.
        // Any future deletion path (admin removeUser, self-service) goes
        // through this hook, so the purge cannot be forgotten.
        after: async (deleted) => {
          await runtime.runPromise(
            Effect.gen(function* () {
              const attachments = yield* AttachmentService;
              yield* attachments.purgeUserFiles(deleted.id);
            }).pipe(
              // The user row is already gone — a store failure must be a log
              // line (the bytes leak until fixed), not an error on a deletion
              // that in fact succeeded.
              Effect.catchCause((cause) =>
                Effect.logError("attachment purge after user delete failed", {
                  userId: deleted.id,
                  cause: String(cause),
                }),
              ),
            ),
          );
        },
      },
    },
  },
  plugins: [admin(), tanstackStartCookies()],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
