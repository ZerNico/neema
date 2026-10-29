import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { POSTGRES_IMAGE } from "./postgres-image.ts";
import { TEMPLATE_DATABASE } from "./database.ts";

declare module "vitest" {
  export interface ProvidedContext {
    postgresAdminUrl: string;
  }
}

/**
 * One server for the whole run; each file clones the migrated template in
 * about 0.1s instead of starting a container and migrating in about 5s.
 */
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(TEMPLATE_DATABASE)
    // Throwaway data: durability only costs time here. Every file holds its
    // own pools, so the default connection limit is too small for the run.
    .withCommand([
      "postgres",
      "-c",
      "max_connections=1000",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ])
    .start();
  execSync("pnpm drizzle-kit migrate", {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    stdio: "pipe",
  });
  const admin = new URL(container.getConnectionUri());
  admin.pathname = "/postgres";
  project.provide("postgresAdminUrl", admin.toString());
  return () => container.stop();
}
