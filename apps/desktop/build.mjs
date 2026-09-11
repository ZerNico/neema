import { build } from "esbuild";

/**
 * Electron loads plain JS, and the sources import with explicit `.ts`
 * extensions, so the three entry points are bundled rather than emitted.
 *
 * `electron` is provided by the runtime. `@anthropic-ai/sandbox-runtime` stays
 * external because it ships vendored native helpers (a seccomp loader, a JVM
 * agent jar, srt-win.exe) that it resolves relative to its own package; bundling
 * would leave those behind and the sandbox would fail to start.
 */
await build({
  entryPoints: ["src/main.ts", "src/preload.ts", "src/connect-preload.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  external: ["electron", "@anthropic-ai/sandbox-runtime"],
});
