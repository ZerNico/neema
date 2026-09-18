import { defineConfig } from "drizzle-kit";

// No fallback: a default would silently target whatever sits on that port. Root
// db:* commands inject this checkout's isolated URL through scripts/dev.mjs.
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("DATABASE_URL is required. Use pnpm db:migrate, or supply it explicitly.");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
