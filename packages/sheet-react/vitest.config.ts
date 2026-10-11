import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sheet-react",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
  },
});
