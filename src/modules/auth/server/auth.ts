import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { count } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { getDb } from "~/shared/db/client.ts";
import * as schema from "~/shared/db/schema/index.ts";

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
    },
  },
  plugins: [admin(), tanstackStartCookies()],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
