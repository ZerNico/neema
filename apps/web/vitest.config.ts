import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { customToolRuntimeWorker } from "./custom-tool-runtime-worker-plugin.ts";
import { paraglide } from "./paraglide.ts";

export default defineConfig({
  // Components are tested as the app builds them, memoized by React Compiler. The tests
  // themselves are not: their harnesses rerender with fakes that read mutable state.
  plugins: [
    customToolRuntimeWorker(),
    // Dev's layout: tests share the output folder with a running dev server.
    paraglide("serve"),
    babel({
      presets: [reactCompilerPreset()],
      exclude: [/[/\\]node_modules[/\\]/, /\.test\.tsx?$/],
    }),
  ],
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
          // Each jsdom file imports most of the app. One worker per core ran
          // the suite at half this cap's speed and timed tests out. A
          // different cap needs its own group, so these run after the rest.
          maxWorkers: "50%",
          sequence: { groupOrder: 1 },
          setupFiles: ["./tests/setup.ui.ts"],
        },
      },
    ],
  },
});
