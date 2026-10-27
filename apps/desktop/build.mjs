import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
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
  try {
    const tree = execSync("git rev-parse HEAD:infra/sandbox-image", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return `ghcr.io/zernico/neema-sandbox:tree-${tree.slice(0, 16)}`;
  } catch {
    // Not a checkout, so no sources to name: main's latest image. Said aloud, since it floats;
    // a release never gets here (it passes SANDBOX_IMAGE_REF, and desktop.yml insists on it).
    console.warn("build: no git checkout, so chats' VMs use the edge sandbox image");
    return "ghcr.io/zernico/neema-sandbox:edge";
  }
};

export const buildOptions = () => ({
  entryPoints: [
    "src/main.ts",
    "src/preload.ts",
    "src/connect-preload.ts",
    "src/app-view-preload.ts",
  ],
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

/**
 * The macOS app driver (docs/internals/app-use.md), built with Swift and placed beside the bundle
 * in dist/, which ships as a plain folder. Elsewhere there is no driver. Without Swift the build
 * goes on and app use says it is unavailable, so a checkout without Xcode can still work on the
 * rest; a release has it, being built on a Mac runner.
 */
export const buildAppDriver = () => {
  if (process.platform !== "darwin") return;
  const packagePath = "native/app-driver/macos";
  try {
    execFileSync("swift", ["build", "-c", "release", "--package-path", packagePath], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (error) {
    console.warn(`build: the app driver was not built, so app use is off: ${error}`);
    return;
  }
  mkdirSync("dist", { recursive: true });
  copyFileSync(`${packagePath}/.build/release/app-driver`, "dist/app-driver");
};

// Run directly: one build. Imported by dev.mjs: the options only.
if (import.meta.main) {
  await compileMessages();
  buildAppDriver();
  await build(buildOptions());
}
