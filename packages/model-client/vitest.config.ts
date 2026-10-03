import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "model-client",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
