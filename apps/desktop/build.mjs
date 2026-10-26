import { execSync } from "node:child_process";
import { build } from "esbuild";
import { compileMessages } from "./paraglide.ts";

/**
 * Electron loads plain JS, and the sources import with explicit `.ts`
 * extensions, so the three entry points are bundled rather than emitted.
 *
 * `electron` is provided by the runtime. `microsandbox` stays external because it
 * loads its native addon, VM runner and libkrunfw from paths inside its own
 * package; bundling would leave those behind and no chat VM could start.
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

/**
 * The guest image chats' VMs boot. A release passes `name:tag@digest` as its sandbox job
 * resolved it (.github/workflows/release.yml). Other builds name the tag CI gives this
 * checkout's committed infra/sandbox-image, so they boot the image of their own sources too.
 * Edits not yet published need `NEEMA_SANDBOX_IMAGE` and a local build.
 */
const sandboxImage = () => {
  if (process.env.SANDBOX_IMAGE_REF) return process.env.SANDBOX_IMAGE_REF;
  const tree = execSync("git rev-parse HEAD:infra/sandbox-image", {
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
  return `ghcr.io/zernico/neema-sandbox:tree-${tree.slice(0, 16)}`;
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
  external: ["electron", "microsandbox"],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp()),
    __SANDBOX_IMAGE__: JSON.stringify(sandboxImage()),
  },
});

// Run directly: one build. Imported by dev.mjs: the options only.
if (import.meta.main) {
  await compileMessages();
  await build(buildOptions());
}
