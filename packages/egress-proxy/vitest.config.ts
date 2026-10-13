import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "egress-proxy",
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Real loopback sockets: one file at a time keeps port and timing noise out.
    fileParallelism: false,
    restoreMocks: true,
  },
});
