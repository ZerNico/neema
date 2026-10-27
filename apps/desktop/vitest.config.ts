import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "desktop",
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Real app drivers from several test files at once stall every screen capture: replayd
    // mixes up processes of one identity (docs/internals/app-use.md). One file at a time then.
    fileParallelism: !process.env.NEEMA_APP_DRIVER,
  },
});
