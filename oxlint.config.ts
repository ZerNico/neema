import { defineConfig } from "oxlint";
import type { SlopRuleName } from "eslint-plugin-slop";

/**
 * Changed lines only: judging untouched code buries the signal under 684 old hits.
 *
 * `uncommitted` (baseline HEAD) rather than `recent-changes` (baseline HEAD~5)
 * until the monorepo move ages out of a five-commit window. Slop resolves its
 * baseline with `git show <rev>:<path>`, which is path-based and blind to
 * renames, so every moved file reads as newly written and the whole codebase
 * lights up. This narrows the window rather than widening it: every line is
 * still judged before it is committed, only the grace period is gone.
 */
const slop = (level: "error" | "warn", ...rules: SlopRuleName[]) =>
  Object.fromEntries(
    rules.map((rule) => [`slop/${rule}`, [level, { inspection: "uncommitted" }]] as const),
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
