// electron-builder hook: drop every other platform's and architecture's natives from the app.
import { join } from "node:path";
import { trimAppDrivers, trimPackage } from "./src/package-trim.ts";

// electron-builder's Arch enum.
const ARCH = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH[context.arch];
  // 7-Zip compresses ARM64 executables with its ARM64 filter, which the installer's
  // extractor cannot decode: it skips every .exe and .dll and still reports success.
  // The archive is made after this hook, so forcing BCJ here covers every build.
  if (platform === "win32") process.env.ELECTRON_BUILDER_7Z_FILTER ??= "BCJ";
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
  if (platform === "win32") await trimAppDrivers(join(resources, "app", "dist"), arch);
}
