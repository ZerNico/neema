// electron-builder hook: give microsandbox's VM runner back the entitlements signing took away.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Signing the app signs every nested binary with the app's own entitlements, which have no
 * hypervisor access, and then no chat VM can start. msb is signed again with its own, and the app
 * resealed around it with the same identity.
 */
export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const runner = join(
    app,
    "Contents/Resources/app/node_modules/@superradcompany/microsandbox-darwin-arm64/bin/msb",
  );
  if (!existsSync(runner)) throw new Error(`msb is missing from the app: ${runner}`);
  const identity = context.packager.platformSpecificBuildOptions.identity ?? "-";
  const entitlements = join(import.meta.dirname, "build-resources/msb.entitlements");
  execFileSync("codesign", ["--force", "--sign", identity, "--entitlements", entitlements, runner]);
  execFileSync("codesign", ["--force", "--sign", identity, app]);
  console.log("  • signed msb with hypervisor entitlements");
}
