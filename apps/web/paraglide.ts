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
  // A module per locale, not per message: dev serves modules unbundled, and one per message
  // was some 4,300 requests on every page load.
  outputStructure: "locale-modules",
} satisfies CompilerOptions;

/** A production build takes a module per message, so the client bundle drops unused ones. */
export const paraglide = (command: "serve" | "build") =>
  paraglideVitePlugin(
    command === "build" ? { ...options, outputStructure: "message-modules" } : options,
  );

/**
 * The same compile without Vite, for `tsc`, which reads the output but cannot write it. It
 * writes where the dev server reads, so it uses dev's layout and does not unsettle a running one.
 */
export const compileMessages = () => compile(options);

/**
 * The desktop shell's copy of the same messages, into its own `src/paraglide`. No strategy beyond
 * the base locale: its main process passes the locale to each message (docs/internals/i18n.md).
 * Compiled from here so both apps use one compiler and one project.
 */
export const compileDesktopMessages = (outdir: string) =>
  compile({
    project: new URL("./project.inlang", import.meta.url).pathname,
    outdir,
    strategy: ["baseLocale"],
    emitTsDeclarations: true,
  });
