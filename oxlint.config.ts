import { defineConfig } from "oxlint";
import type { SlopRuleName } from "eslint-plugin-slop";

/** Changed lines only, including the last five commits, rather than untouched code. */
const slop = (level: "error" | "warn", ...rules: SlopRuleName[]) =>
  Object.fromEntries(
    rules.map((rule) => [`slop/${rule}`, [level, { inspection: "recent-changes" }]] as const),
  );

export default defineConfig({
  plugins: ["typescript", "react", "import", "unicorn", "oxc"],
  jsPlugins: ["eslint-plugin-slop"],
  categories: { correctness: "error", suspicious: "warn", perf: "warn" },
  env: { browser: true, node: true, es2024: true },
  rules: {
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "import/no-cycle": "error",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "react/react-in-jsx-scope": "off",
    "import/no-unassigned-import": "off",
    ...slop(
      "error",
      "no-em-dash",
      "no-jargon",
      "max-comment-length",
      "no-trivial-functions",
      "no-trivial-type-aliases",
      "no-static-only-class",
      "no-chained-type-assertions",
    ),
    ...slop("warn", "prefer-jsdoc"),
  },
  ignorePatterns: [
    "dist",
    ".output",
    ".nitro",
    ".tanstack",
    "node_modules",
    "**/routeTree.gen.ts",
    "**/drizzle/**",
  ],
});
