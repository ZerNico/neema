import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "windows-sandbox-native",
    include: ["tests/windows-sandbox.test.ts"],
    environment: "node",
    fileParallelism: false,
    // Provisioning and native WFP probes run only on a disposable Windows host.
    hookTimeout: 180_000,
    testTimeout: 90_000,
  },
});
