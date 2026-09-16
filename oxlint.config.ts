import { defineConfig } from "oxlint";
import type { SlopRuleName } from "eslint-plugin-slop";

/** Changed lines only, including the last five commits, rather than untouched code. */
const slop = (level: "error" | "warn", ...rules: SlopRuleName[]) =>
  Object.fromEntries(
    rules.map((rule) => [`slop/${rule}`, [level, { inspection: "recent-changes" }]] as const),
  );

// What a call site may do to a component: place it, handle how its text fills the
// box, tint it to a semantic foreground, reveal it. Changing the component's own
// spacing, shape or type scale needs a variant instead.
const callSiteMayDo = [
  "layout",
  "truncate",
  "tabular-nums",
  "text-clip",
  "text-ellipsis",
  "text-muted-foreground",
  "hover:text-foreground",
  "text-destructive",
  "hover:text-destructive",
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
    // Errors, and the count is zero. Every standing exception carries an
    // `oxlint-disable-next-line` with its reason, where the next reader of that
    // line will see it, rather than in a list here that nobody opens.
    "shadcn/no-restyle": [
      "error",
      {
        allow: callSiteMayDo,
        // `src/ui/card.tsx` states it: the surface is shared by padded cards and
        // unpadded ListCards, so padding belongs to each composition.
        contracts: [
          { pattern: "^Card(Content|Header|Footer)?$", allow: [...callSiteMayDo, "spacing"] },
        ],
      },
    ],
    "shadcn/no-raw-colors": "error",
    "shadcn/no-unknown-classes": "error",
    // This app needs viewport math, mask gradients, scrollbar-gutter and Base UI's
    // anchor variables, none of which Tailwind has a token for. The rule found two
    // real magic numbers and wanted forty exemptions, so it does not pay for itself.
    "shadcn/no-arbitrary-values": "off",
    // Every inline style here holds a measured value: a virtualizer offset, a
    // dragged panel width, a marquee distance, a chart series colour. No class
    // can hold one, and the rule found nothing else.
    "shadcn/no-inline-styles": "off",
    // Cannot see through a variable, so it rejects the shared row constants every
    // activity block composes, and Base UI's className-as-function API.
    "shadcn/require-static-classes": "off",
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
      // The design system restating its own primitives, which is the thing the
      // rule protects rather than polices. `primitives/` is CLI-generated on top.
      files: ["apps/web/src/ui/**"],
      rules: { "shadcn/no-restyle": "off", "shadcn/no-unknown-classes": "off" },
    },
    {
      // Tests assert a component forwards className, using a sentinel class no
      // Tailwind build will ever generate.
      files: ["**/*.test.tsx"],
      rules: { "shadcn/no-restyle": "off", "shadcn/no-unknown-classes": "off" },
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
