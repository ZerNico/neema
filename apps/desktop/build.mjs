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

/**
 * The app driver (docs/internals/app-use.md), placed beside the bundle in dist/, which ships as a
 * plain folder: Swift on macOS, Rust on Windows. Elsewhere there is no driver. Without the
 * toolchain the build goes on and app use says it is unavailable, so a checkout without Xcode or
 * Rust can still work on the rest; a release has it, its runners having both.
 */
export const buildAppDriver = () => {
  if (process.platform === "win32") return buildWindowsDriver();
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

const RUST_TARGETS = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };

/**
 * One driver per architecture, `dist/app-driver-<arch>.exe`: CI packages x64 and arm64 from one
 * build (APP_DRIVER_ARCHES), and the packaging hook keeps the installer's own. Elsewhere this
 * machine's alone.
 */
const buildWindowsDriver = () => {
  const manifest = "native/app-driver/windows/Cargo.toml";
  const arches = (process.env.APP_DRIVER_ARCHES ?? process.arch).split(/[\s,]+/).filter(Boolean);
  mkdirSync("dist", { recursive: true });
  for (const arch of arches) {
    const target = RUST_TARGETS[arch];
    try {
      if (!target) throw new Error(`no Rust target for ${arch}`);
      execFileSync(
        "cargo",
        ["build", "--release", "--locked", "--manifest-path", manifest, "--target", target],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      // Windows locks a running executable, as a dev shell's driver is; the build goes on.
      copyFileSync(
        `native/app-driver/windows/target/${target}/release/app-driver.exe`,
        `dist/app-driver-${arch}.exe`,
      );
    } catch (error) {
      console.warn(
        `build: the ${arch} app driver was not updated, so app use is off or stale there: ${error}`,
      );
    }
  }
};

// Run directly: one build. Imported by dev.mjs: the options only.
if (import.meta.main) {
  await compileMessages();
  buildAppDriver();
  await build(buildOptions());
}
