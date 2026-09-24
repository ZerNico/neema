import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { customToolRuntimeWorker } from "./custom-tool-runtime-worker-plugin.ts";

export default defineConfig({
  plugins: [customToolRuntimeWorker()],
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
          globalSetup: ["./tests/integration/global-setup.ts"],
          // Multi-turn generations against a real database under a loaded run.
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
