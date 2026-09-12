import { execSync } from "node:child_process";
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

/**
 * Stamped into the bundle so the running shell can say which build it is.
 * A stale bundle looked exactly like a current one until it answered
 * "Unknown request" to a procedure it had never heard of.
 */
const buildStamp = () => {
  let sha = "unknown";
  try {
    sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    /* not a checkout; the time alone still tells builds apart */
  }
  return `${sha} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
};

export const buildOptions = () => ({
  entryPoints: ["src/main.ts", "src/preload.ts", "src/connect-preload.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  // The package is `type: module`, so a `.js` file here would be loaded as
  // ESM and `require` would be undefined. The output really is CommonJS.
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
  external: ["electron", "@anthropic-ai/sandbox-runtime"],
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp()) },
});

// Run directly: one build. Imported by dev.mjs: the options only.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  await build(buildOptions());
}
