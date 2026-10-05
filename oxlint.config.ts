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
    // Names others fix: Effect's discriminant, TanStack Router's history key,
    // the desktop bridge's window global and a Vite build define.
    "no-underscore-dangle": [
      "warn",
      { allow: ["_tag", "__TSR_index", "__chatDesktop", "__BUILD_STAMP__"] },
    ],
    // Both ask for in-place mutation, the opposite of the immutable updates used throughout.
    "oxc/no-map-spread": "off",
    "oxc/no-accumulating-spread": "off",
    // Plain async loops here are ordered on purpose (streams, redirects, journaled
    // file steps, byte budgets); concurrency is chosen through Effect.forEach.
    "no-await-in-loop": "off",
    "import/no-cycle": "error",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "react/react-in-jsx-scope": "off",
    // Fast Refresh swaps a module only when it exports nothing but components;
    // a helper exported beside one reloads it and everything importing it.
    "react/only-export-components": "warn",
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
      // Tests and scripts keep helpers beside the cases that use them.
      files: ["**/*.test.ts", "**/*.test.tsx", "**/tests/**", "**/scripts/**", "scripts/**"],
      rules: { "unicorn/consistent-function-scoping": "off" },
    },
    {
      // Generated from the shadcn registry; edits would be lost on regenerate.
      files: ["apps/web/src/ui/primitives/**"],
      rules: {
        "no-shadow": "off",
        "react/no-unstable-nested-components": "off",
        "react/no-array-index-key": "off",
      },
    },
    {
      // Route modules export their Route, which the router plugin handles, and
      // shadcn primitives export their variants by design.
      files: ["apps/web/src/routes/**", "apps/web/src/ui/primitives/**", "**/*.test.tsx"],
      rules: { "react/only-export-components": "off" },
    },
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
