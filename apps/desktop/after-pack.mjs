// electron-builder hook: drop every other platform's and architecture's natives from the app.
import { join } from "node:path";
import { trimPackage } from "./src/package-trim.ts";

// electron-builder's Arch enum.
const ARCH = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH[context.arch];
  const resources =
    platform === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : join(context.appOutDir, "resources");
  const removed = await trimPackage(join(resources, "app", "node_modules"), platform, arch);
  console.log(`  • trimmed natives  platform=${platform} arch=${arch} removed=${removed.length}`);
}
