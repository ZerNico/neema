import { type CompilerOptions, compile, paraglideVitePlugin } from "@inlang/paraglide-js";

/**
 * Compiles `messages/` into `src/paraglide`, gitignored like the route tree.
 * The locale is the person’s choice, mirrored into a cookie, else the
 * browser's language; there are no locale URLs. See docs/internals/i18n.md.
 */
const options = {
  project: "./project.inlang",
  outdir: "./src/paraglide",
  strategy: ["custom-chosen", "preferredLanguage", "baseLocale"],
  emitTsDeclarations: true,
} satisfies CompilerOptions;

export const paraglide = () => paraglideVitePlugin(options);

/** The same compile without Vite, for `tsc`, which reads the output but cannot write it. */
export const compileMessages = () => compile(options);
