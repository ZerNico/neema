import { defineConfig } from "oxlint";
import type { SlopRuleName } from "eslint-plugin-slop";

const slop = (level: "error" | "warn", ...rules: SlopRuleName[]) =>
  Object.fromEntries(
    rules.map((rule) => [`slop/${rule}`, [level, { inspection: "full" }]] as const),
  );

/** What a call site may do to a component. See docs/internals/ui.md. */
const callSiteMayDo = [
  "layout",
  "truncate",
  "tabular-nums",
  "text-muted-foreground",
  "hover:text-foreground",
  "text-destructive",
  "opacity-0",
  "opacity-100",
  "transition-opacity",
];

export default defineConfig({
  plugins: ["typescript", "react", "import", "unicorn", "oxc"],
  jsPlugins: ["eslint-plugin-slop", "@shadcn/lint"],
  categories: { correctness: "error", suspicious: "warn", perf: "warn" },
  env: { browser: true, node: true, es2024: true },
  rules: {
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "import/no-cycle": "error",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "react/react-in-jsx-scope": "off",
    "import/no-unassigned-import": "off",
    "shadcn/no-restyle": [
      "error",
      {
        allow: callSiteMayDo,
        contracts: [
          { pattern: "^Card(Content|Header|Footer)?$", allow: [...callSiteMayDo, "spacing"] },
        ],
      },
    ],
    "shadcn/no-raw-colors": "error",
    "shadcn/no-unknown-classes": "error",
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
  overrides: [
    {
      // The design system owns styling; tests exercise class forwarding.
      files: ["apps/web/src/ui/**", "**/*.test.tsx"],
      rules: { "shadcn/no-restyle": "off" },
    },
    {
      files: ["apps/web/src/ui/detail-panel.test.tsx"],
      rules: { "shadcn/no-unknown-classes": ["error", { allow: ["test-panel-class"] }] },
    },
    {
      files: ["apps/web/src/ui/primitives/sonner.tsx"],
      rules: { "shadcn/no-unknown-classes": ["error", { allow: ["toaster"] }] },
    },
  ],
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
