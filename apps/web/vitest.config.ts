import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // Testcontainers startup
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          include: ["src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./tests/setup.ui.ts"],
        },
      },
    ],
  },
});
